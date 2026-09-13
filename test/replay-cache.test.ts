import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createReplayCache } from "../src/replay-cache.js";

test("replay cache rejects a duplicate until its TTL expires", () => {
  const cache = createReplayCache({ ttlMs: 100, maxEntries: 10 });
  assert.equal(cache.seen("SM1", 1_000), false);
  assert.equal(cache.seen("SM1", 1_050), true);
  assert.equal(cache.seen("SM1", 1_101), false);
});

test("replay cache remains bounded", () => {
  const cache = createReplayCache({ ttlMs: 10_000, maxEntries: 2 });
  cache.seen("SM1", 1_000);
  cache.seen("SM2", 1_001);
  cache.seen("SM3", 1_002);
  assert.equal(cache.size(), 2);
  assert.equal(cache.seen("SM1", 1_003), false);
});
