import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import manifest from "../acceptance.lock.json" with { type: "json" };
import { formatRetainedEvidenceVerification, verifyRetainedEvidence } from "../lib/evidence-verifier.mjs";

const roots = [];
test.afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

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

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "ecosystem-verifier-test-"));
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
  for (let position = 1; position <= 3; position += 1) {
    reporter({ state: "done", position, total: 3, name: `bootstrap-${position}`, durationMs: 1 });
  }
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

function packetVerification() {
  return {
    version: 1, kind: "PortableEvidencePacketVerification", outcome: "verified",
    packetSha256: "a".repeat(64), sourceSha256: "b".repeat(64),
    candidateId: "candidate_test", evidenceId: "evidence_test", timestampAttested: false,
  };
}

function result(overrides = {}) {
  return {
    code: 0, signal: null, stdout: "", stderr: "", stdoutExceeded: false, stderrExceeded: false,
    timedOut: false, spawnError: null, ...overrides,
  };
}
