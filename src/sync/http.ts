import { diagnoseAiOperation, type AiDiagnosticSink } from "../diagnostics.js";
import type { ConversationSyncAdapter } from "./types.js";

export interface ConversationSynchronizationHttpHandlerOptions<TContext> {
  readonly adapterFor: (context: TContext) => ConversationSyncAdapter | Promise<ConversationSyncAdapter>;
  readonly maximumBodyBytes?: number;
  readonly diagnostics?: AiDiagnosticSink;
}

function response(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

class SynchronizationBodyTooLargeError extends Error {}

async function readBody(request: Request, maximumBodyBytes: number): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBodyBytes) {
    throw new SynchronizationBodyTooLargeError();
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumBodyBytes) throw new SynchronizationBodyTooLargeError();
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Protected JSON RPC handler for the application gateway synchronization route. */
export function createConversationSynchronizationHttpHandler<TContext>(
  options: ConversationSynchronizationHttpHandlerOptions<TContext>,
): (request: Request, context: TContext) => Promise<Response> {
  const maximumBodyBytes = options.maximumBodyBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maximumBodyBytes) || maximumBodyBytes < 1 || maximumBodyBytes > 16 * 1024 * 1024) {
    throw new TypeError("maximumBodyBytes is invalid");
  }
  return async (request, context) => {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    let parsed: { readonly operation?: unknown; readonly input?: unknown };
    try {
      const bytes = await readBody(request, maximumBodyBytes);
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as typeof parsed;
      if (!parsed || typeof parsed !== "object") return response(400, { ok: false,
        error: { code: "invalid_request", message: "Synchronization request is invalid." } });
    } catch (error) {
      if (error instanceof SynchronizationBodyTooLargeError) return new Response(null, { status: 413 });
      return response(400, { ok: false,
        error: { code: "invalid_request", message: "Synchronization request is invalid." } });
    }
    try {
      const operation = String(parsed.operation ?? "");
      const adapter = await options.adapterFor(context);
      const value = await diagnoseAiOperation(options.diagnostics, {
        domain: "gateway", operation: `synchronization.${operation || "unknown"}`,
      }, async () => operation === "pull_snapshot" ? adapter.pullSnapshot(parsed.input as never)
        : operation === "read_since" ? adapter.readSince(parsed.input as never)
        : operation === "append_mutations" ? adapter.appendMutations(parsed.input as never)
        : null);
      if (value === null) return response(400, { ok: false,
        error: { code: "invalid_request", message: "Synchronization operation is invalid." } });
      return response(200, { ok: true, value });
    } catch {
      return response(503, { ok: false, error: { code: "unavailable",
        message: "Conversation synchronization is unavailable.", retryable: true } });
    }
  };
}
