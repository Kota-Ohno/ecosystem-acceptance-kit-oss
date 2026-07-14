import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import manifest from "../acceptance.lock.json" with { type: "json" };
import { classifyPaths, compareManifests } from "../lib/preflight.mjs";
import { verifyReceipt } from "../lib/receipt.mjs";

test("classifies product, protocol, schema, and acceptance paths", () => {
  const paths = ["src/index.ts", "schemas/event.json", "scripts/verify-acceptance.mjs"];
  assert.deepEqual(classifyPaths("evidenceForge", paths), { product: 3, protocol: 0, schema: 1, acceptance: 1 });
  assert.deepEqual(classifyPaths("solLedger", paths), { product: 0, protocol: 3, schema: 1, acceptance: 1 });
});

test("identical manifests produce a sealed no-change report without network access", async () => {
  const report = await compareManifests({ oldManifest: manifest, newManifest: structuredClone(manifest) });
  assert.equal(report.decision.changeClass, "none");
  assert.equal(report.decision.fullAcceptanceRequired, false);
  assert.equal(report.assurance.networkUsed, false);
  assert.equal(verifyReceipt(report).outcome, "analyzed");
});

test("repository relocation fails closed to manual review without executing code", async () => {
  const newer = structuredClone(manifest);
  newer.repositories.agentBlackBox.url = "https://github.com/example/relocated.git";
  const report = await compareManifests({ oldManifest: manifest, newManifest: newer });
  assert.equal(report.repositories.agentBlackBox.relocated, true);
  assert.equal(report.decision.changeClass, "contract-review");
  assert.equal(report.decision.manualReviewRequired, true);
  assert.equal(report.assurance.exactCommitsCompared, false);
  assert.equal(report.assurance.repositoryCodeExecuted, false);
});

test("writes an exclusive private preflight report", async () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-report-"));
  try {
    const output = join(root, "nested", "report.json");
    const report = await compareManifests({ oldManifest: manifest, newManifest: structuredClone(manifest), output });
    assert.equal(verifyReceipt(report).outcome, "analyzed");
    assert.equal(statSync(output).mode & 0o777, 0o600);
    await assert.rejects(compareManifests({ oldManifest: manifest, newManifest: manifest, output }), /EEXIST/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
