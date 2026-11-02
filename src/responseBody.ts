export const MAX_JSON_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

export class ResponseTooLargeError extends Error {
  constructor(
    readonly limitBytes: number,
    options: { cause?: unknown } = {},
  ) {
    super("Upstream response exceeded the maximum allowed size.", options.cause === undefined ? undefined : options);
    this.name = "ResponseTooLargeError";
  }
}

export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  return JSON.parse(await readBoundedResponseText(response, maxBytes)) as unknown;
}

export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;
  try {
    while (true) {
        // oxlint-disable-next-line eslint/no-await-in-loop
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value.byteLength > maxBytes - totalBytes) {
          // oxlint-disable-next-line eslint/no-await-in-loop
          throw await cancelOversizedReader(reader, maxBytes);
        }
      totalBytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  return text + decoder.decode();
}

async function cancelOversizedReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
): Promise<ResponseTooLargeError> {
  const sizeError = new ResponseTooLargeError(maxBytes);
  try {
    await reader.cancel(sizeError);
    return sizeError;
  } catch (cause) {
    return new ResponseTooLargeError(maxBytes, { cause });
  }
}
