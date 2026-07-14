import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import test from "node:test";
import manifest from "../acceptance.lock.json" with { type: "json" };
import {
  createAutomaticEvidenceDirectory, formatOnboard, onboardFirstEvidence, snapshotInput,
} from "../lib/onboard.mjs";
import { formatRetainedEvidenceVerification, verifyRetainedEvidence } from "../lib/evidence-verifier.mjs";

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

test("cites an entire source through its private snapshot without a second input or quote argv", async () => {
  const root = temporaryRoot();
  const workspace = join(root, "workspace");
  const directory = join(root, "whole-source-evidence");
  const source = join(root, "whole-observation.txt");
  writeFileSync(source, "The complete file is one private observation.\n", { mode: 0o600 });
  const calls = [];
  const report = await onboardFirstEvidence({
    manifest, workspaceRoot: workspace, directory, source, citeEntireSource: true,
    availableAt: "2026-07-14T00:00:00Z", promoteImmediately: true,
    bootstrap: fakeBootstrap, command: fakeCommand(calls, directory, { workflow: "local_file" }),
    resolveTool: (name) => `/trusted/bin/${name}`, createExecutionCheckout: fakeExecutionCheckout,
    verifyCheckout: async () => {},
  });
  assert.deepEqual(calls[1].arguments_.slice(0, 6), [
    "--silent", "forge", "--source", calls[1].arguments_[3], "--exact-file", calls[1].arguments_[3],
  ]);
  assert.notEqual(calls[1].arguments_[3], source);
  assert.doesNotMatch(JSON.stringify(report), /complete file is one private observation/iu);
});

test("validates whole-source citation bytes before bootstrap side effects", async () => {
  const root = temporaryRoot();
  let bootstrapCalls = 0;
  const invalidInputs = [
    Buffer.alloc(0),
    Buffer.alloc(64 * 1024 + 1, 0x61),
    Buffer.from([0xef, 0xbb, 0xbf, 0x61]),
    Buffer.from([0x61, 0, 0x62]),
    Buffer.from([0xc3, 0x28]),
  ];
  for (const [index, bytes] of invalidInputs.entries()) {
    const source = join(root, `invalid-${index}.txt`);
    writeFileSync(source, bytes, { mode: 0o600 });
    await assert.rejects(
      onboardFirstEvidence({
        manifest, workspaceRoot: join(root, "workspace"), directory: join(root, `result-${index}`),
        source, citeEntireSource: true, availableAt: "2026-07-14T00:00:00Z", promoteImmediately: true,
        bootstrap: async () => { bootstrapCalls += 1; return {}; }, resolveTool: (name) => `/trusted/bin/${name}`,
      }),
      /1–65536 bytes of UTF-8 without a BOM or NUL/u,
    );
  }
  assert.equal(bootstrapCalls, 0);
});

test("accepts a whole-source citation at the exact 64 KiB boundary", () => {
  const root = temporaryRoot();
  const source = join(root, "maximum-citation.txt");
  const executionRoot = join(root, "snapshot");
  mkdirSync(executionRoot);
  writeFileSync(source, Buffer.alloc(64 * 1024, 0x61), { mode: 0o600 });
  const snapshot = snapshotInput(source, executionRoot, "input.txt", 64 * 1024, false, undefined, true);
  assert.equal(readFileSync(snapshot).length, 64 * 1024);
});

test("binds a checked source identity to the descriptor used for its snapshot", () => {
  const root = temporaryRoot();
  const source = join(root, "source.txt");
  const moved = join(root, "source-original.txt");
  const executionRoot = join(root, "snapshot");
  mkdirSync(executionRoot);
  writeFileSync(source, "checked inode\n", { mode: 0o600 });
  const checked = lstatSync(source);
  renameSync(source, moved);
  writeFileSync(source, "replacement inode\n", { mode: 0o600 });
  assert.throws(
    () => snapshotInput(source, executionRoot, "input.txt", 1024, false, { dev: checked.dev, ino: checked.ino }),
    /could not be fixed safely/u,
  );
});

test("SIGTERM during bootstrap removes the private source snapshot", { timeout: 4_000 }, async (context) => {
  if (process.platform === "win32") { context.skip("POSIX signals are required"); return; }
  const root = temporaryRoot();
  const source = join(root, "signal-private-source.txt");
  const marker = join(root, "snapshot-root.txt");
  writeFileSync(source, "signal cleanup private observation\n", { mode: 0o600 });
  const helperCode = `
    (async () => {
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      const { onboardFirstEvidence } = await import(${JSON.stringify(new URL("../lib/onboard.mjs", import.meta.url).href)});
      const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(new URL("../acceptance.lock.json", import.meta.url).pathname)}, "utf8"));
      await onboardFirstEvidence({
        manifest,
        workspaceRoot: ${JSON.stringify(join(root, "workspace"))},
        directory: ${JSON.stringify(join(root, "result"))},
        source: ${JSON.stringify(source)},
        citeEntireSource: true,
        availableAt: "2026-07-14T00:00:00Z",
        promoteImmediately: true,
        resolveTool: () => process.execPath,
        bootstrap: async () => {
          const entries = fs.readdirSync(os.tmpdir()).filter((leaf) => leaf.startsWith("ecosystem-onboard-source-"));
          const snapshotRoot = entries
            .map((leaf) => path.join(os.tmpdir(), leaf))
            .filter((candidate) => fs.existsSync(path.join(candidate, "caller-source.bin")))
            .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0];
          fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ snapshotRoot, tmp: os.tmpdir(), entries }));
          await new Promise(() => setInterval(() => {}, 1_000));
        },
      });
    })().catch(() => process.exit(1));
  `;
  const helper = spawn(process.execPath, ["-e", helperCode], { stdio: "ignore" });
  context.after(() => helper.kill("SIGKILL"));
  await waitUntil(() => existsSync(marker));
  const markerContents = JSON.parse(readFileSync(marker, "utf8"));
  const snapshotRoot = markerContents.snapshotRoot;
  assert.equal(existsSync(snapshotRoot), true, JSON.stringify(markerContents));
  helper.kill("SIGTERM");
  const exit = await new Promise((resolve) => helper.once("close", (code, signal) => resolve({ code, signal })));
  assert.deepEqual(exit, { code: 143, signal: null });
  assert.equal(existsSync(snapshotRoot), false);
});

test("re-verifies a retained packet through a fresh pinned checkout without modifying Evidence", async () => {
  const root = temporaryRoot();
  const workspace = join(root, "workspace");
  const directory = join(root, "retained-evidence");
  const packet = join(directory, "evidence-packet.json");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(packet, '{"kind":"PortableEvidencePacket"}\n', { mode: 0o600 });
  const calls = [];
  const progress = [];
  let checkoutVerified = false;
  const expectedSha256 = "a".repeat(64);
  const report = await verifyRetainedEvidence({
    manifest, workspaceRoot: workspace, directory, expectedSha256,
    bootstrap: fakeBootstrap,
    resolveTool: (name) => `/trusted/bin/${name}`,
    createExecutionCheckout: async (options) => {
      await fakeExecutionCheckout(options);
      mkdirSync(join(options.destination, "dist", "src"), { recursive: true });
      writeFileSync(join(options.destination, "dist", "src", "cli.js"), "// verifier\n", { mode: 0o600 });
    },
    command: async (command, arguments_, options) => {
      calls.push({ command, arguments_, options });
      return result({ stdout: arguments_.includes("verify-packet") ? JSON.stringify(packetVerification()) : "" });
    },
    verifyCheckout: async () => { checkoutVerified = true; },
    reporter: (event) => progress.push(event),
  });
  assert.equal(report.kind, "RetainedEvidenceVerification");
  assert.equal(report.outcome, "verified");
  assert.equal(report.packetSha256, expectedSha256);
  assert.equal(report.assurance.expectedDigestArgumentRequired, true);
  assert.equal(report.assurance.kitWritesToEvidenceDirectory, false);
  assert.deepEqual(calls[0].arguments_, ["install", "--frozen-lockfile", "--ignore-scripts"]);
  assert.deepEqual(calls[1].arguments_, ["build"]);
  assert.deepEqual(calls[2].arguments_.slice(1), [
    "verify-packet", "--packet", calls[2].arguments_[3], "--expected-sha256", expectedSha256,
    "--error-format", "json",
  ]);
  assert.notEqual(calls[2].arguments_[3], packet);
  assert.equal(existsSync(calls[2].arguments_[3]), false);
  assert.equal(readFileSync(packet, "utf8"), '{"kind":"PortableEvidencePacket"}\n');
  assert.equal(checkoutVerified, true);
  assert.deepEqual(progress.filter((entry) => entry.state === "done").map((entry) => entry.position), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.match(formatRetainedEvidenceVerification(report), /Retained Evidence: VERIFIED/u);
});

test("rejects an unsafe retained packet before bootstrap", async () => {
  const root = temporaryRoot();
  const directory = join(root, "retained-evidence");
  const target = join(root, "target-packet.json");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(target, "{}\n", { mode: 0o600 });
  symlinkSync(target, join(directory, "evidence-packet.json"));
  let bootstrapped = false;
  await assert.rejects(
    verifyRetainedEvidence({
      manifest, workspaceRoot: join(root, "workspace"), directory, expectedSha256: "a".repeat(64),
      bootstrap: async () => { bootstrapped = true; return {}; },
    }),
    /private regular file/u,
  );
  assert.equal(bootstrapped, false);
});

test("SIGTERM during verifier bootstrap removes the private packet snapshot", { timeout: 4_000 }, async (context) => {
  if (process.platform === "win32") { context.skip("POSIX signals are required"); return; }
  const root = temporaryRoot();
  const directory = join(root, "signal-retained-evidence");
  const marker = join(root, "verify-snapshot-root.txt");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "evidence-packet.json"), '{"private":"signal verification packet"}\n', { mode: 0o600 });
  const helperCode = `
    (async () => {
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      const { verifyRetainedEvidence } = await import(${JSON.stringify(new URL("../lib/evidence-verifier.mjs", import.meta.url).href)});
      const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(new URL("../acceptance.lock.json", import.meta.url).pathname)}, "utf8"));
      await verifyRetainedEvidence({
        manifest,
        workspaceRoot: ${JSON.stringify(join(root, "workspace"))},
        directory: ${JSON.stringify(directory)},
        expectedSha256: ${JSON.stringify("a".repeat(64))},
        resolveTool: () => process.execPath,
        bootstrap: async () => {
          const entries = fs.readdirSync(os.tmpdir()).filter((leaf) => leaf.startsWith("ecosystem-verify-packet-"));
          const snapshotRoot = entries
            .map((leaf) => path.join(os.tmpdir(), leaf))
            .filter((candidate) => fs.existsSync(path.join(candidate, "evidence-packet.json")))
            .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0];
          fs.writeFileSync(${JSON.stringify(marker)}, snapshotRoot);
          await new Promise(() => setInterval(() => {}, 1_000));
        },
      });
    })().catch(() => process.exit(1));
  `;
  const helper = spawn(process.execPath, ["-e", helperCode], { stdio: "ignore" });
  context.after(() => helper.kill("SIGKILL"));
  await waitUntil(() => existsSync(marker));
  const snapshotRoot = readFileSync(marker, "utf8");
  assert.equal(existsSync(snapshotRoot), true);
  helper.kill("SIGTERM");
  const exit = await new Promise((resolve) => helper.once("close", (code, signal) => resolve({ code, signal })));
  assert.deepEqual(exit, { code: 143, signal: null });
  assert.equal(existsSync(snapshotRoot), false);
});

test("classifies retained packet failures without forwarding child diagnostics", async () => {
  const root = temporaryRoot();
  const cases = [
    ["EVIDENCE_PACKET_HEAD_MISMATCH", /does not match --expected-sha256/u],
    ["EVIDENCE_PACKET_INVALID", /invalid or inconsistent/u],
  ];
  for (const [code, message] of cases) {
    const privateDetail = join(root, `${code}-private.json`);
    await assert.rejects(
      retainedVerificationFixture(root, code, {
        verifierResult: result({
          code: 1,
          stderr: JSON.stringify({
            version: 1, kind: "EvidenceForgeCliError", outcome: "error", code,
            message: `must not forward ${privateDetail}`,
          }),
        }),
      }),
      (error) => message.test(error.message) && !error.message.includes(privateDetail),
    );
  }
});

test("rejects impossible verifier claims and packet mutation during the final checkout check", async () => {
  const root = temporaryRoot();
  await assert.rejects(
    retainedVerificationFixture(root, "timestamp-claim", {
      verifierResult: result({ stdout: JSON.stringify({ ...packetVerification(), timestampAttested: true }) }),
    }),
    /did not return the verified result contract/u,
  );

  let packet;
  await assert.rejects(
    retainedVerificationFixture(root, "late-mutation", {
      packetReady: (path) => { packet = path; },
      verifyCheckout: async () => writeFileSync(packet, '{"changed":true}\n', { mode: 0o600 }),
    }),
    /Evidence packet identity changed during verification/u,
  );
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
    /requires --source, exactly one citation selector/u,
  );
  await assert.rejects(
    onboardFirstEvidence({
      manifest, workspaceRoot: workspace, directory, source: join(root, "source.txt"), exact: "quote",
      citeEntireSource: true, availableAt: "2026-07-14T00:00:00Z", promoteImmediately: true, bootstrap,
    }),
    /exactly one citation selector/u,
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

async function waitUntil(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for helper process");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function retainedVerificationFixture(root, name, {
  verifierResult = result({ stdout: JSON.stringify(packetVerification()) }),
  verifyCheckout = async () => {},
  packetReady = () => {},
} = {}) {
  const directory = join(root, `retained-${name}`);
  const packet = join(directory, "evidence-packet.json");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(packet, '{"kind":"PortableEvidencePacket"}\n', { mode: 0o600 });
  packetReady(packet);
  return verifyRetainedEvidence({
    manifest,
    workspaceRoot: join(root, name, "workspace"),
    directory,
    expectedSha256: "a".repeat(64),
    bootstrap: fakeBootstrap,
    resolveTool: (tool) => `/trusted/bin/${tool}`,
    createExecutionCheckout: async (options) => {
      await fakeExecutionCheckout(options);
      mkdirSync(join(options.destination, "dist", "src"), { recursive: true });
      writeFileSync(join(options.destination, "dist", "src", "cli.js"), "// verifier\n", { mode: 0o600 });
    },
    command: async (_command, arguments_) => arguments_.includes("verify-packet") ? verifierResult : result(),
    verifyCheckout,
  });
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
