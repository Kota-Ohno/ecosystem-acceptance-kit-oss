import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import manifest from "../acceptance.lock.json" with { type: "json" };
import {
  assertDisjointRoots, createExecutionEnvironment, createPlan, execute, removeEphemeralPrivateKeys,
} from "../lib/runner.mjs";

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
  mkdirSync(join(stack, "nested"));
  writeFileSync(join(stack, "nested", "packed-nested-private.pem"), "ephemeral");
  writeFileSync(join(stack, "public.pem"), "retained");
  assert.equal(removeEphemeralPrivateKeys(stack), 2);
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

test("isolates child environment secrets and bounds command duration", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "ecosystem-execution-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  process.env.ECOSYSTEM_TEST_SECRET = "must-not-propagate";
  context.after(() => { delete process.env.ECOSYSTEM_TEST_SECRET; });
  const environment = createExecutionEnvironment(root);
  assert.equal(environment.ECOSYSTEM_TEST_SECRET, undefined);
  assert.notEqual(environment.HOME, process.env.HOME);
  await assert.rejects(
    execute(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: root, environment, timeoutMs: 25 }),
    /timed out/u,
  );
});

test("timeout force-kills a SIGTERM-resistant descendant after its parent exits", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "ecosystem-process-tree-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const environment = createExecutionEnvironment(root);
  const pidPath = join(root, "descendant.pid");
  const child = "require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)},${JSON.stringify(pidPath)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const started = Date.now();
  await assert.rejects(
    execute(process.execPath, ["-e", parent], { cwd: root, environment, timeoutMs: 300 }),
    /timed out/u,
  );
  assert.ok(Date.now() - started < 4_000);
  const descendantPid = Number(readFileSync(pidPath, "utf8"));
  let alive = true;
  for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
    try { process.kill(descendantPid, 0); }
    catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
    if (alive) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (alive) process.kill(descendantPid, "SIGKILL");
  assert.equal(alive, false);
});
