import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sealReceipt, verifyReceipt, writeReceipt } from "../lib/receipt.mjs";

test("seals and verifies a canonical receipt", () => {
  const sealed = sealReceipt({ version: 1, outcome: "verified", nested: { b: 2, a: 1 } });
  assert.equal(verifyReceipt(sealed).outcome, "verified");
  assert.match(sealed.integrity.receiptSha256, /^[0-9a-f]{64}$/u);
  assert.throws(() => verifyReceipt({ ...sealed, outcome: "failed" }), /verification failed/);
});

test("writes a private, exclusive receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "ecosystem-receipt-"));
  try {
    const path = join(root, "receipt.json");
    writeReceipt(path, { version: 1, outcome: "verified" });
    readFileSync(path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(() => writeReceipt(path, { version: 1, outcome: "verified" }), /EEXIST/);
  } finally { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }); }
});
