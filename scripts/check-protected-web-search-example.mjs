import assert from "node:assert/strict";
import process from "node:process";

import {
  PROTECTED_WEB_SEARCH_MAXIMUM_BODY_BYTES,
  createDeterministicProtectedWebSearchHarness,
} from "../examples/protected-web-search.mjs";

const SENSITIVE_QUERY = "confidential acquisition planning";
const AUTHENTICATION = Object.freeze({ sessionReference: "opaque-session-reference" });

function execution(overrides = {}) {
  const idempotencyKey = overrides.idempotencyKey ?? "search.example.1";
  const query = overrides.query ?? SENSITIVE_QUERY;
  return {
    requestId: overrides.requestId ?? `request.${idempotencyKey}`,
    origin: overrides.origin ?? "https://app.example.test",
    resource: {
      id: "workspace.example",
      kind: "workspace",
      label: "Example workspace",
      locator: "workspace:example",
    },
    idempotencyKey,
    bodyText: overrides.bodyText ?? JSON.stringify({ query, max_results: 2 }),
    authentication: AUTHENTICATION,
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    deadlineMs: 500,
  };
}

function assertFixedFailure(result, code) {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("Expected a protected failure");
  assert.equal(result.error.code, code);
  assert.deepEqual(
    Object.keys(result.error).sort(),
    code === "rate_limited" || code === "idempotency_in_flight" ||
        code === "concurrency_exhausted"
      ? ["code", "message", "retryAfterMs", "retryable", "status"]
      : ["code", "message", "retryable", "status"],
  );
}

function assertNoEarlyQueryDisclosure(harness) {
  assert.equal(
    harness.outerGateSnapshots.some((snapshot) => snapshot.includes(SENSITIVE_QUERY)),
    false,
    "outer protection hooks never receive the sensitive query",
  );
}

function assertOneTerminalPerExecution(harness, expected) {
  assert.equal(harness.retained.length, expected, "every terminal path is retained exactly once");
  for (const record of harness.retained) {
    assert.equal(JSON.stringify(record).includes(SENSITIVE_QUERY), false);
    assert.equal(JSON.stringify(record).includes(AUTHENTICATION.sessionReference), false);
  }
}

{
  const harness = createDeterministicProtectedWebSearchHarness();
  const result = await harness.execute(execution());
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Expected protected web-search success");
  assert.equal(result.replayed, false);
  assert.deepEqual(harness.trace, [
    "origin",
    "authenticate",
    "authorize",
    "rate-limit",
    "idempotency",
    "concurrency",
    "search-policy",
    "adapter",
    "url-policy",
    "result-policy",
    "release",
    "settle:completed",
    "retain",
  ]);
  assert.deepEqual(harness.adapterCalls, [{
    query: SENSITIVE_QUERY,
    maxResults: 2,
    idempotencyKey: "search.example.1",
  }]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(SENSITIVE_QUERY), false);
  assert.equal(serialized.includes(AUTHENTICATION.sessionReference), false);
  assert.equal(serialized.includes("provider_private_field"), false);
  assert.equal(serialized.includes("discarded-provider-material"), false);
  assert.equal(serialized.includes("credential_reference"), false);
  assert.equal(serialized.includes("raw_response"), false);
  const value = result.value;
  assert.deepEqual(Object.keys(value).sort(), ["citation_records", "results"]);
  assert.deepEqual(Object.keys(value.results[0]).sort(), ["snippet", "source_id", "title", "url"]);
  assert.deepEqual(Object.keys(value.citation_records).sort(), ["citations", "sources"]);
  assert.deepEqual(JSON.parse(JSON.stringify(value.citation_records.sources)), [{
    source_id: "source.example",
    type: "web",
    label: "Handrail search result",
    locator: "https://docs.example.test/handrail",
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(value.citation_records.citations)), [{
    citation_id: "web_search:source.example",
    source_id: "source.example",
    order: 0,
    target: { type: "tool_result", tool_call_id: "request.search.example.1" },
  }]);
  assertNoEarlyQueryDisclosure(harness);
  assertOneTerminalPerExecution(harness, 1);
}

for (const [code, configure] of [
  ["unauthenticated", (controls) => { controls.authenticated = false; }],
  ["forbidden", (controls) => { controls.authorized = false; }],
  ["rate_limited", (controls) => { controls.rateLimited = true; }],
]) {
  const harness = createDeterministicProtectedWebSearchHarness();
  configure(harness.controls);
  const result = await harness.execute(execution({ idempotencyKey: `search.${code}` }));
  assertFixedFailure(result, code);
  assert.equal(harness.adapterCalls.length, 0);
  assertNoEarlyQueryDisclosure(harness);
  assertOneTerminalPerExecution(harness, 1);
}

{
  const harness = createDeterministicProtectedWebSearchHarness();
  const first = await harness.execute(execution({ idempotencyKey: "search.conflict" }));
  assert.equal(first.ok, true);
  const conflict = await harness.execute(execution({
    idempotencyKey: "search.conflict",
    requestId: "request.conflict.2",
    query: "different authoritative query",
  }));
  assertFixedFailure(conflict, "idempotency_conflict");
  assert.equal(harness.adapterCalls.length, 1);
  assertOneTerminalPerExecution(harness, 2);
}

{
  const harness = createDeterministicProtectedWebSearchHarness();
  const hold = harness.holdAdapter();
  const first = harness.execute(execution({ idempotencyKey: "search.inflight" }));
  await hold.entered;
  const inFlight = await harness.execute(execution({
    idempotencyKey: "search.inflight",
    requestId: "request.inflight.2",
  }));
  assertFixedFailure(inFlight, "idempotency_in_flight");
  assert.equal(harness.adapterCalls.length, 1);
  hold.release();
  assert.equal((await first).ok, true);
  assertNoEarlyQueryDisclosure(harness);
  assertOneTerminalPerExecution(harness, 2);
}

{
  const harness = createDeterministicProtectedWebSearchHarness();
  const hold = harness.holdAdapter();
  const first = harness.execute(execution({ idempotencyKey: "search.concurrent.1" }));
  await hold.entered;
  const concurrent = await harness.execute(execution({ idempotencyKey: "search.concurrent.2" }));
  assertFixedFailure(concurrent, "concurrency_exhausted");
  assert.equal(harness.adapterCalls.length, 1);
  hold.release();
  assert.equal((await first).ok, true);
  assertNoEarlyQueryDisclosure(harness);
  assertOneTerminalPerExecution(harness, 2);
}

{
  const harness = createDeterministicProtectedWebSearchHarness();
  const hold = harness.holdAdapter();
  const controller = new globalThis.AbortController();
  const pending = harness.execute(execution({
    idempotencyKey: "search.cancelled",
    signal: controller.signal,
  }));
  await hold.entered;
  controller.abort();
  const cancelled = await pending;
  assertFixedFailure(cancelled, "cancelled");
  hold.release();
  assertNoEarlyQueryDisclosure(harness);
  assertOneTerminalPerExecution(harness, 1);
}

{
  const harness = createDeterministicProtectedWebSearchHarness();
  const input = execution({ idempotencyKey: "search.replay" });
  const first = await harness.execute(input);
  const replay = await harness.execute({ ...input, requestId: "request.replay.2" });
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (!first.ok || !replay.ok) throw new Error("Expected stable replay");
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.value, first.value);
  assert.equal(harness.adapterCalls.length, 1);
  assertNoEarlyQueryDisclosure(harness);
  assertOneTerminalPerExecution(harness, 2);
}

{
  const harness = createDeterministicProtectedWebSearchHarness();
  const result = await harness.execute(execution({
    idempotencyKey: "search.oversized",
    bodyText: "x".repeat(PROTECTED_WEB_SEARCH_MAXIMUM_BODY_BYTES + 1),
  }));
  assertFixedFailure(result, "invalid_body");
  assert.equal(harness.trace.join(","), "retain");
  assert.equal(harness.adapterCalls.length, 0);
  assertOneTerminalPerExecution(harness, 1);
}

process.stdout.write("checked protected web-search recipe terminal paths and redaction\n");
