import { isIP } from "node:net";

function parseIpv6Section(section: string): number[] | undefined {
  if (!section) {
    return [];
  }
  const words = section.split(":");
  if (words.some((word) => !/^[\da-f]{1,4}$/i.test(word))) {
    return undefined;
  }
  return words.map((word) => Number.parseInt(word, 16));
}

export interface HttpEndpointAuthorizer {
  authorize(baseUrl: string, signal?: AbortSignal): Promise<void>;
}

export class HttpEndpointConsentDeniedError extends Error {
  constructor() {
    super("The user declined to send the API key to this HTTP endpoint.");
    this.name = "AbortError";
  }
}

export class HttpEndpointGuard implements HttpEndpointAuthorizer {
  private readonly confirmed = new Set<string>();
  private readonly denied = new Set<string>();
  private readonly pending = new Map<string, Promise<boolean>>();

  constructor(private readonly confirmRemoteHttp: (endpoint: string) => Promise<boolean>) {}

  async authorize(baseUrl: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw requestAborted();
    }

    const endpoint = remoteHttpEndpoint(baseUrl);
    if (!endpoint || this.confirmed.has(endpoint)) {
      return;
    }
    if (this.denied.has(endpoint)) {
      throw new HttpEndpointConsentDeniedError();
    }

    const approved = await this.confirmOnce(endpoint);
    if (signal?.aborted) {
      throw requestAborted();
    }
    if (!approved) {
      this.denied.add(endpoint);
      throw new HttpEndpointConsentDeniedError();
    }
  }

  resetDenials(): void {
    this.denied.clear();
  }

  private async confirmOnce(endpoint: string): Promise<boolean> {
    const pending = this.pending.get(endpoint);
    if (pending) {
      return pending;
    }

    const confirmation = this.confirmRemoteHttp(endpoint);
    this.pending.set(endpoint, confirmation);
    try {
      const approved = await confirmation;
      if (approved) {
        this.confirmed.add(endpoint);
      }
      return approved;
    } finally {
      this.pending.delete(endpoint);
    }
  }
}

export function remoteHttpEndpoint(baseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "http:" || isLoopbackHost(hostname)) {
    return undefined;
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

function isLoopbackHost(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname === "localhost." ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".localhost.")
  ) {
    return true;
  }

  const family = isIP(hostname);
  if (family === 4) {
    return Number(hostname.split(".", 1)[0]) === 127;
  }
  if (family === 6) {
    const words = parseIpv6Words(hostname);
    return Boolean(
      words &&
        (words.slice(0, 7).every((word) => word === 0) && words[7] === 1 ||
          words.slice(0, 5).every((word) => word === 0) &&
            words[5] === 0xffff &&
            (words[6] >> 8) === 127),
    );
  }
  return false;
}

function parseIpv6Words(hostname: string): number[] | undefined {
  const ipv4Tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(hostname);
  let address = hostname;
  if (ipv4Tail) {
    if (isIP(ipv4Tail[1]) !== 4) {
      return undefined;
    }
    const octets = ipv4Tail[1].split(".").map(Number);
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    address = `${hostname.slice(0, -ipv4Tail[1].length)}${high}:${low}`;
  }

  const sections = address.split("::");
    if (sections.length > 2) {
      return undefined;
    }
    const left = parseIpv6Section(sections[0]);
    const right = parseIpv6Section(sections[1] ?? "");
  if (!left || !right) {
    return undefined;
  }

  const zeroCount = 8 - left.length - right.length;
  if ((sections.length === 1 && zeroCount !== 0) || (sections.length === 2 && zeroCount < 1)) {
    return undefined;
  }
  return [...left, ...Array.from({ length: zeroCount }, () => 0), ...right];
}

function requestAborted(): Error {
  const error = new Error("Request canceled before sending the API key.");
  error.name = "AbortError";
  return error;
}
