/** Provider-reported evidence only. Null means unreported, never zero or estimated. */
export interface OpenAIAudioTokenDetails {
  readonly text_tokens: number | null;
  readonly audio_tokens: number | null;
  readonly image_tokens: number | null;
}

export type OpenAIReportedAudioUsage =
  | { readonly type: "unavailable" }
  | { readonly type: "duration"; readonly seconds: number }
  | {
      readonly type: "tokens";
      readonly input_tokens: number | null;
      readonly output_tokens: number | null;
      readonly total_tokens: number | null;
      readonly input_token_details: OpenAIAudioTokenDetails & {
        readonly cached_tokens: number | null;
        readonly cached_tokens_details: OpenAIAudioTokenDetails;
      };
      readonly output_token_details: OpenAIAudioTokenDetails;
    };

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid provider audio usage");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) throw new TypeError("Invalid provider audio usage");
  const result: RecordValue = Object.create(null) as RecordValue;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) throw new TypeError("Invalid provider audio usage");
    result[key] = descriptor.value;
  }
  return result;
}
function quantity(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("Invalid provider audio token count");
  return value as number;
}
function details(value: RecordValue): OpenAIAudioTokenDetails {
  return Object.freeze({ text_tokens: quantity(value.text_tokens), audio_tokens: quantity(value.audio_tokens),
    image_tokens: quantity(value.image_tokens) });
}
function optionalRecord(value: unknown): RecordValue {
  return value === undefined || value === null ? {} : record(value);
}

/**
 * Accepts OpenAI's `usage` object, not a transcript or entire response. Realtime
 * responses omit `type`; transcription reports `tokens` or `duration`. Extra
 * provider fields are discarded. This is evidence, not a Handrail price/receipt.
 */
export function parseOpenAIReportedAudioUsage(value: unknown): OpenAIReportedAudioUsage {
  if (value === undefined || value === null) return Object.freeze({ type: "unavailable" });
  const source = record(value);
  if (source.type === "duration") {
    if (typeof source.seconds !== "number" || !Number.isFinite(source.seconds) || source.seconds < 0 ||
      source.seconds > Number.MAX_SAFE_INTEGER) throw new TypeError("Invalid provider audio duration");
    return Object.freeze({ type: "duration", seconds: source.seconds });
  }
  if (source.type !== undefined && source.type !== "tokens") throw new TypeError("Unknown provider audio usage type");
  const input = optionalRecord(source.input_token_details);
  return Object.freeze({ type: "tokens", input_tokens: quantity(source.input_tokens),
    output_tokens: quantity(source.output_tokens), total_tokens: quantity(source.total_tokens),
    input_token_details: Object.freeze({ ...details(input), cached_tokens: quantity(input.cached_tokens),
      cached_tokens_details: details(optionalRecord(input.cached_tokens_details)) }),
    output_token_details: details(optionalRecord(source.output_token_details)),
  });
}
