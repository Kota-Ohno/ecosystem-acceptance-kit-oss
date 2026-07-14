import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import manifest from "../acceptance.lock.json" with { type: "json" };
import { assertDisjointRoots, createPlan, removeEphemeralPrivateKeys } from "../lib/runner.mjs";

test("plan is non-executing and names every acceptance boundary", () => {
  const plan = createPlan(manifest);
  assert.deepEqual(Object.keys(plan.repositories).sort(), ["agentBlackBox", "evidenceForge", "solLedger"]);
  assert.equal(plan.protocolContractRevision, manifest.protocolContractRevision);
  assert.equal(plan.steps.at(-1), "artifact-digest-and-receipt");
  assert.equal(plan.assurance.executesPinnedRepositoryCode, true);
  assert.equal(plan.assurance.telemetryExported, false);
  assert.equal(plan.assurance.sandboxed, false);
});

test("rejects overlapping output and disposable workspace roots", () => {
  assert.throws(() => assertDisjointRoots("/tmp/acceptance", "/tmp/acceptance"), /disjoint/);
  assert.throws(() => assertDisjointRoots("/tmp/acceptance", "/tmp/acceptance/work"), /disjoint/);
  assert.throws(() => assertDisjointRoots("/tmp/acceptance/out", "/tmp/acceptance"), /disjoint/);
  assert.doesNotThrow(() => assertDisjointRoots("/tmp/acceptance-out", "/tmp/acceptance-work"));
});

test("removes ephemeral private keys without following a stack symlink", (context) => {
  const root = mkdtempSync(join(tmpdir(), "ecosystem-key-cleanup-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const stack = join(root, "stack");
  mkdirSync(stack);
  writeFileSync(join(stack, "packed-a-private.pem"), "ephemeral");
  writeFileSync(join(stack, "public.pem"), "retained");
  assert.equal(removeEphemeralPrivateKeys(stack), 1);
  assert.equal(readFileSync(join(stack, "public.pem"), "utf8"), "retained");
  assert.equal(removeEphemeralPrivateKeys(join(root, "missing")), 0);

  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "packed-b-private.pem"), "must remain");
  const linkedStack = join(root, "linked-stack");
  symlinkSync(outside, linkedStack, "dir");
  assert.equal(removeEphemeralPrivateKeys(linkedStack), 0);
  assert.equal(readFileSync(join(outside, "packed-b-private.pem"), "utf8"), "must remain");
});
