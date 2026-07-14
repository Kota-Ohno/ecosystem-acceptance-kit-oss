import assert from "node:assert/strict";
import test from "node:test";
import { validateManifest } from "../lib/manifest.mjs";

const valid = {
  version: 1,
  protocolContractRevision: "a".repeat(40),
  repositories: Object.fromEntries(["agentBlackBox", "solLedger", "evidenceForge"].map((name, index) => [name, {
    url: `https://github.com/example/repository-${index}.git`,
    revision: String(index + 1).repeat(40),
  }])),
};

test("accepts exact GitHub HTTPS URLs and full revisions", () => {
  assert.deepEqual(validateManifest(valid), valid);
});

test("rejects moving refs and credentialed repository URLs", () => {
  assert.throws(() => validateManifest({ ...valid, repositories: { ...valid.repositories, agentBlackBox: { ...valid.repositories.agentBlackBox, revision: "main" } } }), /full lowercase commit SHA/);
  assert.throws(() => validateManifest({ ...valid, repositories: { ...valid.repositories, solLedger: { ...valid.repositories.solLedger, url: "https://token@github.com/example/repo.git" } } }), /uncredentialed/);
  assert.throws(() => validateManifest({ ...valid, protocolContractRevision: "v0.1.0" }), /protocolContractRevision/);
});

test("rejects extra repositories and fields", () => {
  assert.throws(() => validateManifest({ ...valid, repositories: { ...valid.repositories, surprise: valid.repositories.agentBlackBox } }), /exactly/);
  assert.throws(() => validateManifest({ ...valid, repositories: { ...valid.repositories, evidenceForge: { ...valid.repositories.evidenceForge, branch: "main" } } }), /exactly url and revision/);
});
