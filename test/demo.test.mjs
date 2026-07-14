import assert from "node:assert/strict";
import test from "node:test";
import { formatDemo, runOfflineDemo } from "../lib/demo.mjs";
import { verifyReceipt } from "../lib/receipt.mjs";

test("offline demo verifies a synthetic receipt and rejects mutation", () => {
  const report = runOfflineDemo();
  assert.equal(report.outcome, "demo_verified");
  assert.deepEqual(report.checks, { threeProductRevisionsBound: true, canonicalReceiptVerified: true, tamperRejected: true });
  assert.equal(report.assurance.networkUsed, false);
  assert.equal(report.assurance.externalToolsUsed, false);
  assert.equal(report.assurance.fullAcceptancePassed, false);
  assert.equal(verifyReceipt(report).outcome, "demo_verified");
  assert.match(formatDemo(report), /not a full ecosystem acceptance run/u);
});
