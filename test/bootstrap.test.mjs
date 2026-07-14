import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import test from "node:test";
import manifest from "../acceptance.lock.json" with { type: "json" };
import { bootstrapWorkspace, formatBootstrap, textBootstrapReporter } from "../lib/bootstrap.mjs";

const roots = [];
test.afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

test("bootstraps exact clean checkouts without executing repository code", async () => {
  const root = temporaryRoot();
  const calls = [];
  const progress = [];
  const report = await bootstrapWorkspace({
    manifest,
    workspaceRoot: join(root, "workspace"),
    command: fakeCommand(calls),
    diagnose: fakeDoctor,
    reporter: (event) => progress.push(event),
  });

  assert.equal(report.outcome, "checkout_ready");
  assert.equal(report.mode, "checkout_only");
  assert.equal(report.assurance.repositoryCodeExecuted, false);
  assert.equal(report.assurance.dependenciesInstalled, false);
  assert.deepEqual(Object.values(report.repositories).map((entry) => entry.action), ["created", "created", "created"]);
  assert.equal(calls.every((entry) => isGitCommand(entry.command)), true);
  assert.equal(calls.every((entry) => isAbsolute(entry.command)), true);
  assert.equal(calls.filter((entry) => entry.arguments_[0] === "fetch").length, 3);
  assert.equal(calls.every((entry) => entry.environment?.GIT_CONFIG_KEY_1 === "core.fsmonitor"), true);
  assert.equal(calls.every((entry) => entry.environment?.GIT_NO_REPLACE_OBJECTS === "1"), true);
  assert.deepEqual(
    calls.filter((entry) => basename(entry.cwd) === "agentBlackBox").map((entry) => entry.arguments_),
    [
      ["init", "--quiet", "--template="],
      ["config", "core.hooksPath", "/dev/null"],
      ["remote", "add", "origin", manifest.repositories.agentBlackBox.url],
      ["fetch", "--quiet", "--depth=1", "origin", manifest.repositories.agentBlackBox.revision],
      ["ls-tree", "-r", "--name-only", "FETCH_HEAD"],
      ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
      ["rev-parse", "HEAD"],
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--absolute-git-dir"],
      ["status", "--porcelain", "--untracked-files=all"],
      ["remote", "get-url", "origin"],
    ],
  );
  assert.equal(progress.filter((entry) => entry.state === "done").length, 5);
  assert.match(formatBootstrap(report), /No repository code/u);
  assert.match(formatBootstrap(report), /Full acceptance is separate/u);
});

test("supports an explicit scoped checkout without weakening the default all-repository bootstrap", async () => {
  const root = temporaryRoot();
  const calls = [];
  const progress = [];
  const report = await bootstrapWorkspace({
    manifest,
    workspaceRoot: join(root, "workspace"),
    repositorySelection: ["evidenceForge"],
    command: fakeCommand(calls),
    diagnose: fakeDoctor,
    reporter: (event) => progress.push(event),
  });

  assert.deepEqual(Object.keys(report.repositories), ["evidenceForge"]);
  assert.equal(report.assurance.exactRevisionsChecked, true);
  assert.equal(report.assurance.allRepositoriesChecked, false);
  assert.equal(calls.filter((entry) => entry.arguments_[0] === "fetch").length, 1);
  assert.deepEqual(progress.filter((entry) => entry.state === "done").map((entry) => entry.position), [1, 2, 3]);
  assert.match(formatBootstrap(report), /evidenceForge/u);
  await bootstrapWorkspace({
    manifest, workspaceRoot: join(root, "second"), repositorySelection: ["evidenceForge"],
    command: fakeCommand([]), diagnose: fakeDoctor,
  });
  await assert.rejects(
    bootstrapWorkspace({
      manifest, workspaceRoot: join(root, "invalid"), repositorySelection: ["unknown"],
      command: fakeCommand([]), diagnose: fakeDoctor,
    }),
    /unique known repository names/u,
  );
});

test("reuses only clean exact checkouts and refuses dirty or symlink paths", async () => {
  const root = temporaryRoot();
  const workspace = join(root, "workspace");
  const command = fakeCommand([]);
  await bootstrapWorkspace({ manifest, workspaceRoot: workspace, command, diagnose: fakeDoctor });
  const reused = await bootstrapWorkspace({ manifest, workspaceRoot: workspace, command, diagnose: fakeDoctor });
  assert.deepEqual(Object.values(reused.repositories).map((entry) => entry.action), ["reused", "reused", "reused"]);

  const dirtyCommand = fakeCommand([], { dirty: "agentBlackBox" });
  await assert.rejects(
    bootstrapWorkspace({ manifest, workspaceRoot: workspace, command: dirtyCommand, diagnose: fakeDoctor }),
    /dirty; it was left unchanged/u,
  );

  const redirectedCommand = fakeCommand([], { redirected: "agentBlackBox" });
  await assert.rejects(
    bootstrapWorkspace({ manifest, workspaceRoot: workspace, command: redirectedCommand, diagnose: fakeDoctor }),
    /different worktree; it was left unchanged/u,
  );

  const localAttributes = join(workspace, "agentBlackBox", ".git", "info");
  mkdirSync(localAttributes, { recursive: true });
  writeFileSync(join(localAttributes, "attributes"), "file#name filter=local-driver\n");
  await assert.rejects(
    bootstrapWorkspace({ manifest, workspaceRoot: workspace, command, diagnose: fakeDoctor }),
    /.git\/info\/attributes can invoke/u,
  );
  rmSync(join(localAttributes, "attributes"));

  const linkedRoot = temporaryRoot();
  const outside = join(linkedRoot, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(linkedRoot, "linked"), "dir");
  await assert.rejects(
    bootstrapWorkspace({ manifest, workspaceRoot: join(linkedRoot, "linked"), command, diagnose: fakeDoctor }),
    /real directory/u,
  );
  assert.equal(existsSync(outside), true);

  const linkedGitRoot = temporaryRoot();
  const linkedGitWorkspace = join(linkedGitRoot, "workspace");
  mkdirSync(join(linkedGitWorkspace, "agentBlackBox"), { recursive: true });
  symlinkSync(outside, join(linkedGitWorkspace, "agentBlackBox", ".git"), "dir");
  await assert.rejects(
    bootstrapWorkspace({ manifest, workspaceRoot: linkedGitWorkspace, command, diagnose: fakeDoctor }),
    /.git directory must be a real directory/u,
  );
});

test("checkout failures identify authentication without echoing captured stderr", async () => {
  const root = temporaryRoot();
  const command = async (executable, arguments_, options) => {
    if (isGitCommand(executable) && arguments_[0] === "fetch") {
      return { code: 128, signal: null, stdout: "", stderr: "Authentication failed for secret-detail", stdoutExceeded: false, stderrExceeded: false, timedOut: false, spawnError: null };
    }
    return fakeCommand([])(executable, arguments_, options);
  };
  await assert.rejects(
    bootstrapWorkspace({ manifest, workspaceRoot: join(root, "workspace"), command, diagnose: fakeDoctor }),
    (error) => {
      assert.match(error.message, /private repository access was denied/u);
      assert.doesNotMatch(error.message, /secret-detail/u);
      return true;
    },
  );
});

test("text progress is bounded and JSON callers can keep stdout separate", () => {
  let text = "";
  const reporter = textBootstrapReporter((chunk) => { text += chunk; });
  reporter({ state: "start", position: 1, total: 5, name: "offline-demo" });
  reporter({ state: "done", position: 1, total: 5, name: "offline-demo", durationMs: 12 });
  assert.equal(text, "[01/05] ▶ offline-demo\n[01/05] ✓ offline-demo (0.0s)\n");
});

test("rejects relative PATH entries before creating a workspace", async () => {
  const root = temporaryRoot();
  const workspace = join(root, "workspace");
  await assert.rejects(
    bootstrapWorkspace({
      manifest, workspaceRoot: workspace, command: fakeCommand([]), diagnose: fakeDoctor,
      sourceEnvironment: { ...process.env, PATH: `.${delimiter}/usr/bin` },
    }),
    /PATH to contain only absolute directories/u,
  );
  assert.equal(existsSync(workspace), false);
});

test("pins Git before a future checkout directory can affect PATH lookup", async () => {
  const root = temporaryRoot();
  const workspace = join(root, "workspace");
  const calls = [];
  await bootstrapWorkspace({
    manifest, workspaceRoot: workspace, command: fakeCommand(calls), diagnose: fakeDoctor,
    sourceEnvironment: { ...process.env, PATH: `${join(workspace, "agentBlackBox")}${delimiter}${process.env.PATH}` },
  });
  assert.equal(calls.every((entry) => isAbsolute(entry.command) && !entry.command.startsWith(workspace)), true);
  assert.equal(calls.every((entry) => !entry.environment.PATH.split(delimiter).includes(join(workspace, "agentBlackBox"))), true);
});

test("offline doctor also ignores executables inside a reused checkout", async () => {
  const root = temporaryRoot();
  const workspace = join(root, "workspace");
  const checkout = join(workspace, "agentBlackBox");
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, "git"), "#!/bin/sh\necho repository-controlled\n", { mode: 0o700 });
  let doctorAvoidedCheckoutGit = false;
  const inspectDoctor = async ({ execute }) => {
    const result = await execute("git", ["--version"], { cwd: checkout });
    doctorAvoidedCheckoutGit = !`${result.stdout}\n${result.stderr}`.includes("repository-controlled");
    return fakeDoctor();
  };
  await assert.rejects(
    bootstrapWorkspace({
      manifest, workspaceRoot: workspace, command: fakeCommand([]), diagnose: inspectDoctor,
      sourceEnvironment: { ...process.env, PATH: `${checkout}${delimiter}${process.env.PATH}` },
    }),
    /.git directory must be a real directory/u,
  );
  assert.equal(doctorAvoidedCheckoutGit, true);
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "ecosystem-bootstrap-test-"));
  roots.push(root);
  return root;
}

function fakeCommand(calls, { dirty, redirected } = {}) {
  return async (command, arguments_, { cwd, environment } = {}) => {
    calls.push({ command, arguments_, cwd, environment });
    if (isGitCommand(command) && arguments_[0] === "init") mkdirSync(join(cwd, ".git"));
    if (isGitCommand(command) && arguments_[0] === "checkout") writeFileSync(join(cwd, ".checkout-created"), "ignored by fake status");
    const name = repositoryName(cwd);
    let stdout = "";
    if (isGitCommand(command) && arguments_[0] === "rev-parse" && arguments_[1] === "HEAD") stdout = `${manifest.repositories[name].revision}\n`;
    if (isGitCommand(command) && arguments_[0] === "rev-parse" && arguments_[1] === "--show-toplevel") {
      stdout = `${name === redirected ? roots[0] : cwd}\n`;
    }
    if (isGitCommand(command) && arguments_[0] === "rev-parse" && arguments_[1] === "--absolute-git-dir") stdout = `${join(cwd, ".git")}\n`;
    if (isGitCommand(command) && arguments_[0] === "status") stdout = name === dirty ? " M tracked-file\n" : "";
    if (isGitCommand(command) && arguments_[0] === "remote" && arguments_[1] === "get-url") stdout = `${manifest.repositories[name].url}\n`;
    return { code: 0, signal: null, stdout, stderr: "", stdoutExceeded: false, stderrExceeded: false, timedOut: false, spawnError: null };
  };
}

function isGitCommand(command) {
  return /^git(?:\.exe|\.cmd)?$/iu.test(basename(command));
}

function repositoryName(path) {
  const name = basename(path);
  return Object.keys(manifest.repositories).find((candidate) => name === candidate || name.startsWith(`.bootstrap-${candidate}-`));
}

async function fakeDoctor() {
  return {
    version: 1,
    outcome: "local_ready",
    checks: [{ name: "git", available: true, version: "2.50.0" }],
    assurance: { repositoryCodeExecuted: false },
  };
}
