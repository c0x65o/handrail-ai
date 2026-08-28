export interface ServerSentEventFrame {
  readonly event?: string;
  readonly id?: string;
  readonly data?: string;
}

export interface IncrementalSseParserOptions {
  readonly maxLineLength?: number;
  readonly maxDataLength?: number;
}

const DEFAULT_MAX_LINE_LENGTH = 1_048_576;
const DEFAULT_MAX_DATA_LENGTH = 2_097_152;

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > fallback) {
    throw new TypeError(`${name} must be an integer between 1 and ${fallback}`);
  }
  return value;
}

/**
 * Incrementally decodes UTF-8 and parses standard SSE fields. Unknown fields
 * and comments are ignored. A final unterminated frame is dispatched at EOF.
 */
export class IncrementalSseParser {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #maxLineLength: number;
  readonly #maxDataLength: number;
  #buffer = "";
  #event: string | undefined;
  #id: string | undefined;
  #data: string[] = [];
  #dataLength = 0;
  #recognizedField = false;
  #finished = false;

  constructor(options: IncrementalSseParserOptions = {}) {
    this.#maxLineLength = boundedPositiveInteger(
      options.maxLineLength,
      DEFAULT_MAX_LINE_LENGTH,
      "maxLineLength",
    );
    this.#maxDataLength = boundedPositiveInteger(
      options.maxDataLength,
      DEFAULT_MAX_DATA_LENGTH,
      "maxDataLength",
    );
  }

  push(chunk: Uint8Array): ServerSentEventFrame[] {
    if (this.#finished) throw new TypeError("The SSE parser is already finished");
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError("SSE chunks must be Uint8Array values");
    }
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    return this.#drain(false);
  }

  finish(): ServerSentEventFrame[] {
    if (this.#finished) return [];
    this.#finished = true;
    this.#buffer += this.#decoder.decode();
    return this.#drain(true);
  }

  #drain(eof: boolean): ServerSentEventFrame[] {
    const frames: ServerSentEventFrame[] = [];
    let offset = 0;

    while (offset < this.#buffer.length) {
      let lineEnd = offset;
      while (
        lineEnd < this.#buffer.length &&
        this.#buffer[lineEnd] !== "\r" &&
        this.#buffer[lineEnd] !== "\n"
      ) {
        lineEnd += 1;
      }

      if (lineEnd === this.#buffer.length) {
        if (!eof) break;
        this.#consumeLine(this.#buffer.slice(offset), frames);
        offset = lineEnd;
        break;
      }

      if (
        !eof &&
        this.#buffer[lineEnd] === "\r" &&
        lineEnd + 1 === this.#buffer.length
      ) {
        break;
      }

      this.#consumeLine(this.#buffer.slice(offset, lineEnd), frames);
      offset =
        this.#buffer[lineEnd] === "\r" && this.#buffer[lineEnd + 1] === "\n"
          ? lineEnd + 2
          : lineEnd + 1;
    }

    this.#buffer = this.#buffer.slice(offset);
    if (this.#buffer.length > this.#maxLineLength) {
      throw new TypeError("An SSE line exceeded the configured limit");
    }
    if (eof) {
      const frame = this.#dispatch();
      if (frame !== null) frames.push(frame);
      this.#buffer = "";
    }
    return frames;
  }

  #consumeLine(line: string, frames: ServerSentEventFrame[]): void {
    if (line.length > this.#maxLineLength) {
      throw new TypeError("An SSE line exceeded the configured limit");
    }
    if (line.length === 0) {
      const frame = this.#dispatch();
      if (frame !== null) frames.push(frame);
      return;
    }
    if (line.startsWith(":")) return;

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        this.#event = value;
        this.#recognizedField = true;
        break;
      case "id":
        if (value.includes("\0")) {
          throw new TypeError("An SSE id must not contain a null character");
        }
        this.#id = value;
        this.#recognizedField = true;
        break;
      case "data": {
        const dataLength = this.#dataLength + value.length + this.#data.length;
        if (dataLength > this.#maxDataLength) {
          throw new TypeError("SSE event data exceeded the configured limit");
        }
        this.#data.push(value);
        this.#dataLength += value.length;
        this.#recognizedField = true;
        break;
      }
      default:
        break;
    }
  }

  #dispatch(): ServerSentEventFrame | null {
    if (!this.#recognizedField) return null;
    const frame: ServerSentEventFrame = {
      ...(this.#event === undefined ? {} : { event: this.#event }),
      ...(this.#id === undefined ? {} : { id: this.#id }),
      ...(this.#data.length === 0 ? {} : { data: this.#data.join("\n") }),
    };
    this.#event = undefined;
    this.#id = undefined;
    this.#data = [];
    this.#dataLength = 0;
    this.#recognizedField = false;
    return frame;
  }
}

async function* readChunks(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) return;
      yield item.value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Parse an SSE byte source without assuming network chunk boundaries. */
export async function* parseServerSentEvents(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  options: IncrementalSseParserOptions = {},
): AsyncGenerator<ServerSentEventFrame, void, void> {
  const parser = new IncrementalSseParser(options);
  const chunks =
    "getReader" in source ? readChunks(source) : (source as AsyncIterable<Uint8Array>);
  for await (const chunk of chunks) {
    for (const frame of parser.push(chunk)) yield frame;
  }
  for (const frame of parser.finish()) yield frame;
}
