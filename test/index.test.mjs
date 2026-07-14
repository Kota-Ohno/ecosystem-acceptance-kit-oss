import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendIndex, verifyIndexFile } from "../lib/index.mjs";
import { writeReceipt } from "../lib/receipt.mjs";

const revisions = Object.fromEntries(["agentBlackBox", "evidenceForge", "solLedger", "solLedgerContract"].map((name, index) => [name, String(index + 1).repeat(40)]));

function acceptance(root, sequence) {
  const path = join(root, `receipt-${sequence}.json`);
  const receipt = writeReceipt(path, {
    version: 1, outcome: "verified", runId: `run-${sequence}`, completedAt: `2026-07-1${sequence}T00:00:00.000Z`, revisions,
    artifacts: {
      releasePack: { file: "stack/pack.json", sha256: String(sequence + 4).repeat(64) },
      stackReport: { file: "stack/report.json", sha256: String(sequence + 5).repeat(64) },
      verificationReceipt: { file: "stack/receipt.json", sha256: String(sequence + 6).repeat(64) },
    },
    assurance: { exactRevisionsChecked: true, productChecksPassed: true, packedAcceptancePassed: true, ephemeralPrivateKeysRetained: false },
  });
  return { path, head: receipt.integrity.receiptSha256 };
}

test("appends externally headed receipts to a private verified hash chain", () => {
  const root = mkdtempSync(join(tmpdir(), "acceptance-index-"));
  try {
    const first = acceptance(root, 1);
    const firstPath = join(root, "index-1.json");
    const index1 = appendIndex({ receipt: first.path, expectedReceiptSha256: first.head, output: firstPath });
    assert.equal(statSync(firstPath).mode & 0o777, 0o600);
    const second = acceptance(root, 2);
    const secondPath = join(root, "index-2.json");
    const index2 = appendIndex({ receipt: second.path, expectedReceiptSha256: second.head, previousIndex: firstPath, expectedIndexSha256: index1.integrity.indexSha256, output: secondPath });
    assert.equal(verifyIndexFile(secondPath, index2.integrity.indexSha256).entries, 2);
    assert.equal(index2.entries[1].previousEntrySha256, index1.entries[0].entrySha256);
    assert.throws(() => appendIndex({ receipt: second.path, expectedReceiptSha256: second.head, previousIndex: secondPath, expectedIndexSha256: index2.integrity.indexSha256, output: join(root, "duplicate.json") }), /already indexed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects wrong external heads and index mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "acceptance-index-fail-"));
  try {
    const first = acceptance(root, 1);
    assert.throws(() => appendIndex({ receipt: first.path, expectedReceiptSha256: "f".repeat(64), output: join(root, "wrong.json") }), /independently supplied head/);
    const indexPath = join(root, "index.json");
    const index = appendIndex({ receipt: first.path, expectedReceiptSha256: first.head, output: indexPath });
    const mutated = JSON.parse(readFileSync(indexPath, "utf8"));
    mutated.entries[0].runId = "changed";
    writeFileSync(indexPath, JSON.stringify(mutated));
    assert.throws(() => verifyIndexFile(indexPath, index.integrity.indexSha256), /integrity verification failed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
