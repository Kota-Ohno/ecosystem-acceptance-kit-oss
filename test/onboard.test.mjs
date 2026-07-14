import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import test from "node:test";
import manifest from "../acceptance.lock.json" with { type: "json" };
import { createAutomaticEvidenceDirectory, formatOnboard, onboardFirstEvidence } from "../lib/onboard.mjs";

const roots = [];
test.afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

test("creates a bounded collision-resistant default leaf without claiming evidence time", () => {
  const directory = createAutomaticEvidenceDirectory(
    "/private/runs", new Date("2026-07-14T13:45:01.234Z"), "12345678-1234-4abc-8def-1234567890ab",
  );
  assert.equal(directory, "/private/runs/evidence-20260714T134501Z-12345678");
  assert.throws(() => createAutomaticEvidenceDirectory("/tmp", new Date("invalid"), "bad"), /valid time and UUID/u);
  assert.throws(() => createAutomaticEvidenceDirectory(
    "/tmp", new Date("2026-07-14T00:00:00Z"), "------------------------------------",
  ), /valid time and UUID/u);
});

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
  assert.deepEqual(progress.filter((entry) => entry.state === "done").map((entry) => entry.position), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(progress.every((entry) => entry.total === 8), true);
  assert.equal(report.version, 1);
  assert.equal(report.workflow, undefined);
  assert.equal(report.evidence, undefined);
  assert.match(formatOnboard(report), /Verified Evidence: READY/u);
  assert.match(formatOnboard(report), /lifecycle scripts disabled/u);
});

test("creates verified Evidence from a caller-selected local file without retaining source inputs in the report", async () => {
  const root = temporaryRoot();
  const workspace = join(root, "workspace");
  const directory = join(root, "local-evidence");
  const source = join(root, "source.txt");
  const exact = "A caller-selected exact observation.";
  const exactFile = join(root, "exact.txt");
  writeFileSync(source, `${exact}\n`, { mode: 0o600 });
  writeFileSync(exactFile, exact, { mode: 0o600 });
  const calls = [];
  const progress = [];
  const report = await onboardFirstEvidence({
    manifest,
    workspaceRoot: workspace,
    directory,
    source,
    exactFile,
    availableAt: "2026-07-11T00:00:00Z",
    promoteImmediately: true,
    bootstrap: fakeBootstrap,
    command: fakeCommand(calls, directory, { workflow: "local_file" }),
    resolveTool: (name) => `/trusted/bin/${name}`,
    createExecutionCheckout: fakeExecutionCheckout,
    verifyCheckout: async () => {},
    reporter: (event) => progress.push(event),
  });

  assert.equal(report.version, 2);
  assert.equal(report.workflow, "local_file");
  assert.equal(report.evidence.kind, "EvidenceForgeLocalFileResult");
  assert.equal(report.quickstart, undefined);
  assert.equal(report.assurance.callerSourceUsed, true);
  assert.equal(report.assurance.promotionPreauthorized, true);
  assert.deepEqual(report.scope, { repositoriesChecked: ["evidenceForge"], allRepositoriesChecked: false });
  assert.deepEqual(calls[1].arguments_, [
    "--silent", "forge", "--source", calls[1].arguments_[3], "--exact-file", calls[1].arguments_[5],
    "--available-at", "2026-07-11T00:00:00Z", "--directory", directory, "--promote-immediately",
  ]);
  assert.notEqual(calls[1].arguments_[3], source);
  assert.match(calls[1].arguments_[3], /ecosystem-onboard-source-.+caller-source\.bin$/u);
  assert.notEqual(calls[1].arguments_[5], exactFile);
  assert.match(calls[1].arguments_[5], /ecosystem-onboard-source-.+caller-exact\.txt$/u);
  assert.deepEqual(calls[2].arguments_.slice(1), [
    "verify-packet", "--packet", join(directory, "evidence-packet.json"), "--expected-sha256", "a".repeat(64),
  ]);
  assert.deepEqual(progress.filter((entry) => entry.state === "done").map((entry) => entry.position), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(progress.every((entry) => entry.total === 8), true);
  assert.doesNotMatch(JSON.stringify(report), /caller-selected exact observation/u);
  assert.doesNotMatch(JSON.stringify(report), /source\.txt/u);
  assert.match(formatOnboard(report), /caller-selected local file/u);
  assert.match(formatOnboard(report), /Evidence Forge only/u);
  assert.match(formatOnboard(report), /Immediate promotion was preauthorized/u);
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

test("rejects incomplete, missing, symlinked, or overlapping local sources before bootstrap", async () => {
  const root = temporaryRoot();
  const workspace = join(root, "workspace");
  const directory = join(root, "result");
  let bootstrapped = false;
  const bootstrap = async () => { bootstrapped = true; return {}; };
  await assert.rejects(
    onboardFirstEvidence({ manifest, workspaceRoot: workspace, directory, source: join(root, "source.txt"), bootstrap }),
    /requires --source, exactly one of --exact or --exact-file/u,
  );
  const invalidTimestampSource = join(root, "timestamp-source.txt");
  writeFileSync(invalidTimestampSource, "quote\n", { mode: 0o600 });
  await assert.rejects(
    onboardFirstEvidence({
      manifest, workspaceRoot: workspace, directory, source: invalidTimestampSource, exact: "quote",
      availableAt: "definitely-not-iso", promoteImmediately: true, bootstrap,
    }),
    /--available-at must be an RFC 3339 timestamp/u,
  );
  const missing = join(root, "private-missing-source.txt");
  await assert.rejects(
    onboardFirstEvidence({
      manifest, workspaceRoot: workspace, directory, source: missing, exact: "quote",
      availableAt: "2026-07-11T00:00:00Z", promoteImmediately: true, bootstrap,
    }),
    (error) => !error.message.includes(missing) && /source is unavailable/u.test(error.message),
  );
  const source = join(root, "source.txt");
  const link = join(root, "source-link.txt");
  writeFileSync(source, "quote\n");
  symlinkSync(source, link);
  await assert.rejects(
    onboardFirstEvidence({
      manifest, workspaceRoot: workspace, directory, source: link, exact: "quote",
      availableAt: "2026-07-11T00:00:00Z", promoteImmediately: true, bootstrap,
    }),
    /non-symbolic-link file/u,
  );
  mkdirSync(workspace);
  const overlapping = join(workspace, "source.txt");
  writeFileSync(overlapping, "quote\n");
  await assert.rejects(
    onboardFirstEvidence({
      manifest, workspaceRoot: workspace, directory, source: overlapping, exact: "quote",
      availableAt: "2026-07-11T00:00:00Z", promoteImmediately: true, bootstrap,
    }),
    /must not overlap/u,
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
    /persisted workflow result does not match/u,
  );
  assert.equal(calls.length, 2);
});

test("fails closed on empty verifier output or artifacts inconsistent with the verified packet", async () => {
  const root = temporaryRoot();
  const common = {
    manifest, workspaceRoot: join(root, "workspace"), bootstrap: fakeBootstrap,
    resolveTool: (name) => `/trusted/bin/${name}`,
    createExecutionCheckout: fakeExecutionCheckout, verifyCheckout: async () => {},
  };
  await assert.rejects(
    onboardFirstEvidence({
      ...common, directory: join(root, "empty-verifier"),
      command: fakeCommand([], join(root, "empty-verifier"), { emptyVerifier: true }),
    }),
    /verifier returned invalid JSON/u,
  );
  await assert.rejects(
    onboardFirstEvidence({
      ...common, directory: join(root, "bad-artifact"),
      command: fakeCommand([], join(root, "bad-artifact"), { corruptArtifact: true }),
    }),
    /artifacts do not match/u,
  );
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

async function fakeBootstrap({ manifest: input, workspaceRoot, reporter, repositorySelection }) {
  const checkout = join(workspaceRoot, "evidenceForge");
  mkdirSync(checkout, { recursive: true });
  assert.deepEqual(repositorySelection, ["evidenceForge"]);
  for (let position = 1; position <= 3; position += 1) reporter({ state: "done", position, total: 3, name: `bootstrap-${position}`, durationMs: 1 });
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

function fakeCommand(calls, directory, {
  corruptArtifact = false, corruptPersistedResult = false, emptyVerifier = false, workflow = "tutorial",
} = {}) {
  let position = 0;
  return async (command, arguments_, options) => {
    calls.push({ command, arguments_, options });
    position += 1;
    if (position === 2) {
      mkdirSync(directory, { mode: 0o700 });
      const cli = join(calls[0].options.cwd, "dist", "src");
      mkdirSync(cli, { recursive: true });
      writeFileSync(join(cli, "cli.js"), "// fake verifier\n", { mode: 0o600 });
      const artifacts = artifactInventory(workflow);
      const report = evidenceResult(artifacts, workflow);
      for (const [name, leaf] of Object.entries(artifacts)) {
        const content = JSON.stringify(fakeArtifact(name, report, corruptPersistedResult, corruptArtifact));
        writeFileSync(join(directory, leaf), content, { mode: 0o600 });
      }
      return result({ stdout: JSON.stringify(report) });
    }
    if (position === 3) return result({ stdout: emptyVerifier ? "" : JSON.stringify(packetVerification()) });
    return result();
  };
}

function fakeArtifact(name, report, corruptPersistedResult, corruptArtifact) {
  const snapshot = { sha256: "b".repeat(64) };
  if (name === "candidate") return { kind: "EvidenceCandidate", id: report.candidateId, snapshot };
  if (name === "evidence") return {
    kind: "VerifiedEvidence", id: corruptArtifact ? "evidence_other" : report.evidenceId,
    candidateId: report.candidateId, snapshot,
  };
  if (name === "packet") return {
    kind: "PortableEvidencePacket", source: { sha256: snapshot.sha256 },
    candidate: { id: report.candidateId }, evidence: { id: report.evidenceId },
  };
  if (name === "verification") return packetVerification();
  if (name === "result") return corruptPersistedResult ? { ...report, outcome: "corrupt" } : report;
  return "tutorial source";
}

function packetVerification() {
  return {
    version: 1, kind: "PortableEvidencePacketVerification", outcome: "verified",
    packetSha256: "a".repeat(64), sourceSha256: "b".repeat(64),
    candidateId: "candidate_test", evidenceId: "evidence_test", timestampAttested: false,
  };
}

function artifactInventory(workflow = "tutorial") {
  const common = {
    candidate: "candidate.json", evidence: "verified-evidence.json",
    packet: "evidence-packet.json", verification: "packet-verification.json",
  };
  return workflow === "local_file"
    ? { ...common, result: "forge-result.json" }
    : { source: "source.txt", ...common, result: "quickstart-result.json" };
}

function evidenceResult(artifacts, workflow = "tutorial") {
  return {
    version: 1,
    kind: workflow === "local_file" ? "EvidenceForgeLocalFileResult" : "EvidenceForgeQuickstartResult",
    outcome: "verified",
    stages: workflow === "local_file"
      ? [
          { name: "capture", status: "observation" }, { name: "promote", status: "evidence" },
          { name: "packet", status: "portable" }, { name: "verify", status: "verified" },
        ]
      : [
          { name: "capture", outputKind: "EvidenceCandidate", status: "observation" },
          { name: "promote", outputKind: "VerifiedEvidence", status: "evidence" },
          { name: "packet", outputKind: "PortableEvidencePacket" }, { name: "verify", outcome: "verified" },
        ],
    artifacts,
    candidateId: "candidate_test",
    evidenceId: "evidence_test",
    packetSha256: "a".repeat(64),
    assurance: {
      localOnly: true,
      existingFilesOverwritten: false,
      rawSourcePrinted: false,
      timestampAttested: false,
      ...(workflow === "local_file" ? { promotionPreauthorized: true } : {}),
    },
  };
}

function result(overrides = {}) {
  return {
    code: 0, signal: null, stdout: "", stderr: "", stdoutExceeded: false, stderrExceeded: false,
    timedOut: false, spawnError: null, ...overrides,
  };
}
