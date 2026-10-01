import assert from "node:assert/strict";
import { test } from "node:test";
import { createSealer } from "../src/seal.ts";

test("round-trips a value", () => {
  const sealer = createSealer("s".repeat(40));
  assert.deepEqual(sealer.unseal(sealer.seal({ a: 1 }, 60)), { a: 1 });
});

test("rejects tampered, foreign and expired tokens", () => {
  let now = 1_000_000;
  const sealer = createSealer("s".repeat(40), () => now);
  const token = sealer.seal({ a: 1 }, 60);
  const tampered = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
  assert.equal(sealer.unseal(tampered), null);
  assert.equal(createSealer("t".repeat(40)).unseal(token), null);
  assert.equal(sealer.unseal("garbage"), null);
  now += 61_000;
  assert.equal(sealer.unseal(token), null);
});
