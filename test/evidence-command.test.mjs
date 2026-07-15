import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  confirmEvidenceIntent, evidenceProgressReporter, formatEvidenceFailure, formatEvidenceStart, formatEvidenceSummary,
  parseEvidenceArguments, prepareEvidenceSource,
} from "../lib/evidence-command.mjs";

const digest = "a".repeat(64);

test("parses the one-positional human path with collision-resistant defaults", () => {
  const options = parseEvidenceArguments(["notes.txt"], {
    cwd: "/private/project",
    defaultManifest: "/kit/acceptance.lock.json",
    createDirectory: (root) => resolve(root, "evidence-unique"),
  });
  assert.deepEqual(options, {
    command: "evidence",
    manifest: "/kit/acceptance.lock.json",
    workspaceRoot: "/private/project/evidence-ecosystem-workspace",
    source: "/private/project/notes.txt",
    directory: "/private/project/evidence-unique",
    yes: false,
    json: false,
  });
});

test("requires explicit time and consent for non-interactive JSON", () => {
  const context = {
    cwd: "/private/project", defaultManifest: "/kit/acceptance.lock.json",
    createDirectory: () => "/private/evidence",
    now: () => new Date("2026-07-16T00:00:00Z"),
  };
  assert.throws(() => parseEvidenceArguments(["notes.txt", "--json"], context), /--json requires --yes/u);
  assert.throws(() => parseEvidenceArguments(["notes.txt", "--yes"], context), /requires --available-at/u);
  assert.throws(() => parseEvidenceArguments([
    "notes.txt", "--yes", "--available-at", "not-a-time",
  ], context), /RFC 3339/u);
  assert.throws(() => parseEvidenceArguments([
    "notes.txt", "--yes", "--available-at", "2026-02-30T00:00:00Z",
  ], context), /RFC 3339/u);
  assert.throws(() => parseEvidenceArguments([
    "notes.txt", "--yes", "--available-at", "2026-07-17T00:00:00Z",
  ], context), /cannot be in the future/u);
  const options = parseEvidenceArguments([
    "notes.txt", "--yes", "--available-at", "2026-07-15T00:00:00Z", "--json",
    "--directory", "result", "--workspace-root", "workspace",
  ], context);
  assert.equal(options.availableAt, "2026-07-15T00:00:00Z");
  assert.equal(options.directory, "/private/project/result");
  assert.equal(options.workspaceRoot, "/private/project/workspace");
  assert.equal(options.json, true);
  assert.throws(() => parseEvidenceArguments([
    "notes.txt", "--manifest", "/tmp/untrusted.json",
  ], context), /Usage:/u);
});

test("collects three explicit human decisions before work starts", async () => {
  const questions = [];
  const answers = ["yes", "now", "y"];
  let closed = false;
  let introduction = "";
  const result = await confirmEvidenceIntent({ yes: false, sourceSha256: "f".repeat(64) }, {
    input: { isTTY: true },
    output: { isTTY: true, write: (value) => { introduction += value; } },
    now: () => new Date("2026-07-15T01:02:03.456Z"),
    createPrompt: () => ({
      question: async (question) => { questions.push(question); return answers.shift(); },
      close: () => { closed = true; },
    }),
  });
  assert.deepEqual(result, { availableAt: "2026-07-15T01:02:03.456Z" });
  assert.equal(questions.length, 3);
  assert.match(introduction, /does not prove/u);
  assert.match(introduction, /may contact GitHub/u);
  assert.match(introduction, new RegExp("f{64}", "u"));
  assert.equal(closed, true);
});

test("preserves a supplied interactive observation time instead of replacing it", async () => {
  const questions = [];
  let output = "";
  const result = await confirmEvidenceIntent({
    yes: false, availableAt: "2026-07-01T00:00:00Z",
  }, {
    input: { isTTY: true },
    output: { isTTY: true, write: (value) => { output += value; } },
    now: () => new Date("2026-07-15T01:02:03.456Z"),
    createPrompt: () => ({
      question: async (question) => { questions.push(question); return "yes"; }, close: () => {},
    }),
  });
  assert.deepEqual(result, { availableAt: "2026-07-01T00:00:00Z" });
  assert.equal(questions.length, 2);
  assert.match(output, /Observation time from --available-at: 2026-07-01T00:00:00Z/u);
});

test("keeps an interactive user in the guide until time is explicit and valid", async () => {
  const answers = ["yes", "", "2026-02-30T00:00:00Z", "now", "yes"];
  let output = "";
  const result = await confirmEvidenceIntent({ yes: false }, {
    input: { isTTY: true }, output: { isTTY: true, write: () => {} },
    now: () => new Date("2026-07-15T01:02:03.456Z"),
    createPrompt: () => ({ question: async () => answers.shift(), close: () => {} }),
  });
  assert.deepEqual(result, { availableAt: "2026-07-15T01:02:03.456Z" });
});

test("never waits for prompts without a terminal and supports explicit automation", async () => {
  await assert.rejects(
    confirmEvidenceIntent({ yes: false }, { input: { isTTY: false }, output: { isTTY: false } }),
    /requires a terminal/u,
  );
  assert.deepEqual(
    await confirmEvidenceIntent({ yes: true, availableAt: "2026-07-15T00:00:00Z" }),
    { availableAt: "2026-07-15T00:00:00Z" },
  );
});

test("cancellation is explicit and closes the prompt before side effects", async () => {
  let closed = false;
  await assert.rejects(confirmEvidenceIntent({ yes: false }, {
    input: { isTTY: true }, output: { isTTY: true, write: () => {} },
    createPrompt: () => ({ question: async () => "no", close: () => { closed = true; } }),
  }), /Cancelled before creating Evidence/u);
  assert.equal(closed, true);
});

test("translates implementation progress into human tasks", () => {
  let output = "";
  let evidenceCreated = 0;
  const reporter = evidenceProgressReporter((chunk) => { output += chunk; }, {
    onEvidenceCreated: () => { evidenceCreated += 1; },
  });
  reporter({ state: "start", position: 1, total: 8, name: "offline-demo" });
  reporter({ state: "done", position: 1, total: 8, name: "offline-demo", durationMs: 125 });
  reporter({ state: "failed", position: 6, total: 8, name: "evidence-forge:local-file", durationMs: 125 });
  reporter({ state: "done", position: 6, total: 8, name: "evidence-forge:local-file", durationMs: 125 });
  assert.match(output, /Check the local verifier/u);
  assert.doesNotMatch(output, /offline-demo/u);
  assert.match(output, /\[01\/08\]/u);
  assert.match(output, /START ▶/u);
  assert.match(output, /DONE\s+✓/u);
  assert.equal(evidenceCreated, 1);
});

test("explains outcome, retained data, limitations, and the next operation", () => {
  const report = {
    version: 2,
    workflow: "local_file",
    workspace: "/private/work space",
    directory: "/private/evidence\u001b[31m",
    evidenceForge: { revision: "b".repeat(40), checkoutAction: "reused" },
    evidence: { artifacts: { packet: "evidence-packet.json" }, packetSha256: digest },
  };
  const output = formatEvidenceSummary(report);
  assert.match(output, /What happened/u);
  assert.match(output, /What was recorded/u);
  assert.match(output, /What to do next/u);
  assert.match(output, /not independently attested/u);
  assert.match(output, new RegExp(digest, "u"));
  assert.doesNotMatch(output, /\u001b/u);
  assert.match(output, /\\u001b\[31m/u);
  assert.match(output, /separately re-checked/u);
  assert.doesNotMatch(output, /independently re-checked/u);
});

test("shows a terminal-safe output location before work and after a retained failure", () => {
  const directory = "/private/evidence\u001b[31m";
  const start = formatEvidenceStart(directory);
  const failure = formatEvidenceFailure(directory);
  assert.match(start, /new private directory/u);
  assert.match(failure, /not a verified result/u);
  assert.match(failure, /different new directory/u);
  assert.doesNotMatch(`${start}${failure}`, /\u001b/u);
  assert.match(`${start}${failure}`, /\\u001b\[31m/u);
});

test("fixes the eligible source bytes before consent and removes the private snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "evidence-command-test-"));
  try {
    const source = join(root, "source.txt");
    const original = "consented bytes\n";
    writeFileSync(source, original);
    const prepared = prepareEvidenceSource({
      source, workspaceRoot: join(root, "workspace"), directory: join(root, "evidence"),
    });
    const snapshotRoot = dirname(prepared.path);
    assert.equal(readFileSync(prepared.path, "utf8"), original);
    assert.equal(prepared.sha256, createHash("sha256").update(original).digest("hex"));
    writeFileSync(source, "replacement bytes\n");
    assert.equal(readFileSync(prepared.path, "utf8"), original);
    prepared.cleanup();
    assert.equal(existsSync(snapshotRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an ineligible source before prompting or network work", () => {
  const root = mkdtempSync(join(tmpdir(), "evidence-command-test-"));
  try {
    const source = join(root, "empty.txt");
    writeFileSync(source, "");
    assert.throws(() => prepareEvidenceSource({
      source, workspaceRoot: join(root, "workspace"), directory: join(root, "evidence"),
    }), /non-empty UTF-8/u);
    assert.throws(() => prepareEvidenceSource({
      source: join(root, "missing.txt"), workspaceRoot: join(root, "workspace"), directory: join(root, "evidence"),
    }), /source is unavailable/u);
    const existing = join(root, "existing-output");
    mkdirSync(existing);
    writeFileSync(join(existing, "KEEP.txt"), "user-owned file");
    assert.throws(() => prepareEvidenceSource({
      source, workspaceRoot: join(root, "workspace"), directory: existing,
    }), /already exists/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
