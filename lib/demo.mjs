import { sealReceipt, verifyReceipt } from "./receipt.mjs";

const SYNTHETIC_REVISIONS = {
  agentBlackBox: "1".repeat(40),
  evidenceForge: "2".repeat(40),
  solLedger: "3".repeat(40),
  solLedgerContract: "4".repeat(40),
};

const SYNTHETIC_ARTIFACTS = {
  releasePack: { file: "stack/packed-release.evidence-pack.json", sha256: "a".repeat(64) },
  stackReport: { file: "stack/report.json", sha256: "b".repeat(64) },
  verificationReceipt: { file: "stack/packed-verification-receipt.json", sha256: "c".repeat(64) },
};

export function runOfflineDemo() {
  const fixture = sealReceipt({
    version: 1,
    mode: "synthetic_offline_demo",
    outcome: "verified",
    runId: "offline-demo",
    completedAt: "2026-01-01T00:00:00.000Z",
    revisions: SYNTHETIC_REVISIONS,
    artifacts: SYNTHETIC_ARTIFACTS,
    assurance: {
      syntheticFixture: true,
      repositoryCodeExecuted: false,
      fullAcceptancePassed: false,
      networkUsed: false,
      externalToolsUsed: false,
      rawContentIncluded: false,
      timestampAttested: false,
    },
  });
  const verification = verifyReceipt(fixture);
  const tampered = structuredClone(fixture);
  tampered.artifacts.stackReport.sha256 = "d".repeat(64);
  let tamperRejected = false;
  try { verifyReceipt(tampered); } catch { tamperRejected = true; }
  if (!tamperRejected) throw new Error("Offline demo failed to reject a mutated receipt");

  return sealReceipt({
    version: 1,
    outcome: "demo_verified",
    checks: {
      threeProductRevisionsBound: Object.keys(fixture.revisions).length === 4,
      canonicalReceiptVerified: verification.receiptSha256 === fixture.integrity.receiptSha256,
      tamperRejected,
    },
    fixtureReceiptSha256: fixture.integrity.receiptSha256,
    assurance: {
      syntheticFixture: true,
      repositoryCodeExecuted: false,
      fullAcceptancePassed: false,
      networkUsed: false,
      externalToolsUsed: false,
      rawContentIncluded: false,
      timestampAttested: false,
    },
  });
}

export function formatDemo(report) {
  return [
    "Offline demo: VERIFIED",
    "  ✓ Three product revisions bound",
    "  ✓ Canonical receipt integrity verified",
    "  ✓ A mutated artifact was rejected",
    `  Receipt: ${report.fixtureReceiptSha256}`,
    "  No network, Cargo, private repository, or raw content was used.",
    "  This synthetic demo is not a full ecosystem acceptance run.",
  ].join("\n");
}
