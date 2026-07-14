import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import test from "node:test";
import manifest from "../acceptance.lock.json" with { type: "json" };
import { formatOnboard, onboardFirstEvidence } from "../lib/onboard.mjs";

const roots = [];
test.afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

test("creates first verified Evidence through one explicit progress-reporting command", async () => {
  const root = temporaryRoot();
  const workspace = join(root, "workspace");
  const directory = join(root, "first-evidence");
  const calls = [];
  const progress = [];
  let checkoutVerified = false;
  const report = await onboardFirstEvidence({
    manifest,
    workspaceRoot: workspace,
    directory,
    bootstrap: fakeBootstrap,
    command: fakeCommand(calls, directory),
    resolveTool: (name) => `/trusted/bin/${name}`,
    createExecutionCheckout: fakeExecutionCheckout,
    sourceEnvironment: { ...process.env, PATH: `${workspace}${delimiter}${process.env.PATH}` },
    verifyCheckout: async ({ path, entry }) => {
      checkoutVerified = path !== join(workspace, "evidenceForge") && entry.revision === manifest.repositories.evidenceForge.revision;
    },
    reporter: (event) => progress.push(event),
  });

  assert.equal(report.outcome, "first_evidence_ready");
  assert.equal(report.assurance.repositoryCodeExecuted, true);
  assert.equal(report.assurance.dependenciesInstalledWithScriptsDisabled, true);
  assert.equal(report.assurance.checkoutCleanAfterRun, true);
  assert.deepEqual(calls[0].arguments_, ["install", "--frozen-lockfile", "--ignore-scripts"]);
  assert.deepEqual(calls[1].arguments_, ["--silent", "quickstart", "--directory", directory]);
  assert.equal(calls[2].command, "/trusted/bin/node");
  assert.deepEqual(calls[2].arguments_.slice(1), [
    "verify-packet", "--packet", join(directory, "evidence-packet.json"), "--expected-sha256", "a".repeat(64),
  ]);
  assert.equal(calls.every((entry) => isAbsolute(entry.command)), true);
  assert.equal(calls.every((entry) => !entry.options.environment.PATH.split(delimiter).includes(workspace)), true);
  assert.equal(checkoutVerified, true);
  assert.deepEqual(progress.filter((entry) => entry.state === "done").map((entry) => entry.position), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(progress.every((entry) => entry.total === 10), true);
  assert.match(formatOnboard(report), /First verified Evidence: READY/u);
  assert.match(formatOnboard(report), /lifecycle scripts disabled/u);
});

test("rejects overlapping or existing output before bootstrap side effects", async () => {
  const root = temporaryRoot();
  let bootstrapped = false;
  const bootstrap = async () => { bootstrapped = true; return {}; };
  await assert.rejects(
    onboardFirstEvidence({
      manifest, workspaceRoot: join(root, "workspace"), directory: join(root, "workspace", "result"), bootstrap,
    }),
    /must not overlap/u,
  );
  const existing = join(root, "existing");
  mkdirSync(existing);
  await assert.rejects(
    onboardFirstEvidence({ manifest, workspaceRoot: join(root, "workspace"), directory: existing, bootstrap }),
    /already exists/u,
  );
  assert.equal(bootstrapped, false);
});

test("fails before bootstrap on native Windows where shell-free pnpm shims are unsupported", async () => {
  const root = temporaryRoot();
  let bootstrapped = false;
  await assert.rejects(
    onboardFirstEvidence({
      manifest,
      workspaceRoot: join(root, "workspace"),
      directory: join(root, "first-evidence"),
      platform: "win32",
      bootstrap: async () => { bootstrapped = true; return {}; },
    }),
    /native Windows is unsupported/u,
  );
  assert.equal(bootstrapped, false);
});

test("redacts package-manager stderr and fails closed on an unverified result", async () => {
  const root = temporaryRoot();
  const workspace = join(root, "workspace");
  const directory = join(root, "first-evidence");
  await assert.rejects(
    onboardFirstEvidence({
      manifest, workspaceRoot: workspace, directory, bootstrap: fakeBootstrap,
      resolveTool: (name) => `/trusted/bin/${name}`,
      createExecutionCheckout: fakeExecutionCheckout,
      verifyCheckout: async () => {},
      command: async () => result({ code: 1, stderr: "token=must-not-leak" }),
    }),
    (error) => {
      assert.match(error.message, /dependency installation failed/u);
      assert.doesNotMatch(error.message, /must-not-leak/u);
      return true;
    },
  );

  let call = 0;
  await assert.rejects(
    onboardFirstEvidence({
      manifest, workspaceRoot: workspace, directory, bootstrap: fakeBootstrap,
      resolveTool: (name) => `/trusted/bin/${name}`,
      createExecutionCheckout: fakeExecutionCheckout,
      verifyCheckout: async () => {},
      command: async () => ++call === 1 ? result() : result({ stdout: JSON.stringify({ outcome: "verified" }) }),
    }),
    /did not return the verified result contract/u,
  );
});

test("rejects a persisted result that differs from process output", async () => {
  const root = temporaryRoot();
  const workspace = join(root, "workspace");
  const directory = join(root, "first-evidence");
  const calls = [];
  await assert.rejects(
    onboardFirstEvidence({
      manifest, workspaceRoot: workspace, directory, bootstrap: fakeBootstrap,
      resolveTool: (name) => `/trusted/bin/${name}`,
      createExecutionCheckout: fakeExecutionCheckout,
      verifyCheckout: async () => {},
      command: fakeCommand(calls, directory, { corruptPersistedResult: true }),
    }),
    /persisted quickstart result does not match/u,
  );
  assert.equal(calls.length, 2);
});

test("classifies common package failures without forwarding captured details", async () => {
  const root = temporaryRoot();
  await assert.rejects(
    onboardFirstEvidence({
      manifest, workspaceRoot: join(root, "workspace"), directory: join(root, "first-evidence"), bootstrap: fakeBootstrap,
      resolveTool: (name) => `/trusted/bin/${name}`,
      createExecutionCheckout: fakeExecutionCheckout,
      verifyCheckout: async () => {},
      command: async () => result({ code: 1, stderr: "ERR_PNPM_META_FETCH_FAIL https://token@example.invalid ENOTFOUND" }),
    }),
    (error) => {
      assert.match(error.message, /check network and TLS settings/u);
      assert.doesNotMatch(error.message, /token@example/u);
      return true;
    },
  );
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "ecosystem-onboard-test-"));
  roots.push(root);
  return root;
}

async function fakeBootstrap({ manifest: input, workspaceRoot, reporter }) {
  const checkout = join(workspaceRoot, "evidenceForge");
  mkdirSync(checkout, { recursive: true });
  for (let position = 1; position <= 5; position += 1) reporter({ state: "done", position, total: 5, name: `bootstrap-${position}`, durationMs: 1 });
  return {
    repositories: {
      evidenceForge: { path: checkout, revision: input.repositories.evidenceForge.revision, action: "created" },
    },
  };
}

async function fakeExecutionCheckout({ destination, entry, fetchSource }) {
  assert.match(fetchSource, /workspace\/evidenceForge$/u);
  mkdirSync(destination, { recursive: true });
  mkdirSync(join(destination, ".git"));
  return { path: destination, revision: entry.revision, action: "created" };
}

function fakeCommand(calls, directory, { corruptPersistedResult = false } = {}) {
  let position = 0;
  return async (command, arguments_, options) => {
    calls.push({ command, arguments_, options });
    position += 1;
    if (position === 2) {
      mkdirSync(directory, { mode: 0o700 });
      const cli = join(calls[0].options.cwd, "dist", "src");
      mkdirSync(cli, { recursive: true });
      writeFileSync(join(cli, "cli.js"), "// fake verifier\n", { mode: 0o600 });
      const artifacts = artifactInventory();
      const report = quickstartResult(artifacts);
      for (const [name, leaf] of Object.entries(artifacts)) {
        const content = name === "result" ? JSON.stringify(corruptPersistedResult ? { ...report, outcome: "corrupt" } : report) : "{}";
        writeFileSync(join(directory, leaf), content, { mode: 0o600 });
      }
      return result({ stdout: JSON.stringify(report) });
    }
    return result();
  };
}

function artifactInventory() {
  return {
    source: "source.txt", candidate: "candidate.json", evidence: "verified-evidence.json",
    packet: "evidence-packet.json", verification: "packet-verification.json", result: "quickstart-result.json",
  };
}

function quickstartResult(artifacts) {
  return {
    version: 1,
    kind: "EvidenceForgeQuickstartResult",
    outcome: "verified",
    artifacts,
    packetSha256: "a".repeat(64),
    assurance: { localOnly: true, existingFilesOverwritten: false },
  };
}

function result(overrides = {}) {
  return {
    code: 0, signal: null, stdout: "", stderr: "", stdoutExceeded: false, stderrExceeded: false,
    timedOut: false, spawnError: null, ...overrides,
  };
}
