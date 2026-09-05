import { describe, expect, it } from "vitest";
import { parseOpenAIReportedAudioUsage } from "../src/providers/openai-audio-usage.js";

describe("OpenAI reported audio usage", () => {
  it("retains realtime modality/cache subsets without summing or leaking extra fields", () => {
    expect(parseOpenAIReportedAudioUsage({ input_tokens: 132, output_tokens: 121, total_tokens: 253,
      input_token_details: { text_tokens: 119, audio_tokens: 13, image_tokens: 0, cached_tokens: 64,
        cached_tokens_details: { text_tokens: 64, audio_tokens: 0, image_tokens: 0 } },
      output_token_details: { text_tokens: 30, audio_tokens: 91 }, transcript: "private", credentials: "private",
    })).toEqual({ type: "tokens", input_tokens: 132, output_tokens: 121, total_tokens: 253,
      input_token_details: { text_tokens: 119, audio_tokens: 13, image_tokens: 0, cached_tokens: 64,
        cached_tokens_details: { text_tokens: 64, audio_tokens: 0, image_tokens: 0 } },
      output_token_details: { text_tokens: 30, audio_tokens: 91, image_tokens: null },
    });
  });
  it("distinguishes absent counts, reported zero, and fractional duration", () => {
    expect(parseOpenAIReportedAudioUsage(undefined)).toEqual({ type: "unavailable" });
    expect(parseOpenAIReportedAudioUsage({ type: "duration", seconds: 2.75, duration: 100 })).toEqual({ type: "duration", seconds: 2.75 });
    expect(parseOpenAIReportedAudioUsage({ type: "tokens", input_tokens: 0, output_tokens: 9,
      input_token_details: { audio_tokens: 0 } })).toMatchObject({ type: "tokens", input_tokens: 0,
      output_tokens: 9, total_tokens: null, input_token_details: { text_tokens: null, audio_tokens: 0,
        cached_tokens: null, cached_tokens_details: { audio_tokens: null } } });
  });
  it.each([ { type: "duration", seconds: -1 }, { type: "duration", seconds: Infinity },
    { input_tokens: 1.5 }, { total_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { input_token_details: { audio_tokens: "20" } }, { type: "other" }, [],
  ])("rejects malformed provider evidence (%j)", (value) => {
    expect(() => parseOpenAIReportedAudioUsage(value)).toThrow(TypeError);
  });
  it("does not execute getters in provider usage", () => {
    let reads = 0;
    expect(() => parseOpenAIReportedAudioUsage({ get input_tokens() { reads += 1; return 1; } })).toThrow(TypeError);
    expect(reads).toBe(0);
  });
});
