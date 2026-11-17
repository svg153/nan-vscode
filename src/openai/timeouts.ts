import { RequestTimeoutError, type RequestTimeoutKind } from "./request";

export const DEFAULT_CONNECT_TIMEOUT_SECONDS = 20;
export const DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS = 120;
export const MIN_TIMEOUT_SECONDS = 1;
export const MAX_TIMEOUT_SECONDS = 3600;

export interface ChatTimeouts {
  /** Deadline for the response headers of a chat request. */
  readonly connectTimeoutSeconds: number;
  /** Maximum silence between streamed chunks; re-armed on every chunk. */
  readonly streamIdleTimeoutSeconds: number;
}

export const DEFAULT_CHAT_TIMEOUTS: ChatTimeouts = {
  connectTimeoutSeconds: DEFAULT_CONNECT_TIMEOUT_SECONDS,
  streamIdleTimeoutSeconds: DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS,
};

/** Clamps a configured value into a usable whole-second deadline. */
export function resolveTimeoutSeconds(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, Math.floor(value)));
}

/**
 * Owns the two chat-request timers. The connect timer requires response
 * headers; the idle timer is re-armed on every streamed chunk so a slow but
 * alive stream is never cut off by a total deadline.
 *
 * The controller aborts the request signal with a {@link RequestTimeoutError}
 * so the caller can tell a timeout apart from user cancellation and clear the
 * timers in `finally`.
 */
export class ChatTimeoutController {
  private connectTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private timeoutValue?: RequestTimeoutError;
  private settled = false;

  constructor(
    private readonly timeouts: ChatTimeouts,
    private readonly abortRequest: (reason: RequestTimeoutError) => void,
  ) {}

  /** The timeout that fired, while it is still needed to report the failure. */
  get timeoutError(): RequestTimeoutError | undefined {
    return this.timeoutValue;
  }

  /**
   * Starts a fresh deadline for the response headers of one HTTP send. Any
   * timer left over from a previous send (or its error body) is cleared, so a
   * fallback request always receives the full deadline.
   */
  armConnect(): void {
    if (this.settled || this.timeoutValue) {
      return;
    }
    this.clearConnect();
    this.clearIdle();
    this.armTimer("connect", this.timeouts.connectTimeoutSeconds);
  }

  /** Response headers arrived: stop the connect deadline and start the idle one. */
  startStream(): void {
    if (this.settled || this.timeoutValue) {
      return;
    }
    this.clearConnect();
    this.armIdle();
  }

  /** A chunk arrived, so re-arm the idle deadline. */
  touch(): void {
    if (this.settled || this.timeoutValue) {
      return;
    }
    this.armIdle();
  }

  /** Clears every timer and ignores late callbacks. */
  settle(): void {
    this.settled = true;
    this.clearConnect();
    this.clearIdle();
  }

  private armIdle(): void {
    this.clearIdle();
    this.armTimer("stream-idle", this.timeouts.streamIdleTimeoutSeconds);
  }

  private armTimer(kind: RequestTimeoutKind, seconds: number): void {
    if (this.settled || this.timeoutValue) {
      return;
    }
    const handle = setTimeout(() => this.fail(kind, seconds), seconds * 1000);
    if (kind === "connect") {
      this.connectTimer = handle;
    } else {
      this.idleTimer = handle;
    }
  }

  private fail(kind: RequestTimeoutKind, seconds: number): void {
    if (this.settled || this.timeoutValue) {
      return;
    }
    const error = new RequestTimeoutError(kind, seconds);
    this.timeoutValue = error;
    this.clearConnect();
    this.clearIdle();
    this.abortRequest(error);
  }

  private clearConnect(): void {
    if (this.connectTimer !== undefined) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
  }

  private clearIdle(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}
