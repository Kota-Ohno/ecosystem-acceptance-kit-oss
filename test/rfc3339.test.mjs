import assert from "node:assert/strict";
import test from "node:test";
import { isRfc3339 } from "../lib/rfc3339.mjs";

test("accepts real RFC 3339 timestamps and leap days", () => {
  assert.equal(isRfc3339("2024-02-29T23:59:59Z"), true);
  assert.equal(isRfc3339("2026-07-15T01:02:03.456+09:00"), true);
});

test("rejects normalized calendar dates and out-of-range clock fields", () => {
  for (const value of [
    "2026-02-29T00:00:00Z", "2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z",
    "2026-13-01T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z",
    "2026-01-01T00:00:60Z", "2026-01-01T00:00:00+24:00",
  ]) assert.equal(isRfc3339(value), false, value);
});
