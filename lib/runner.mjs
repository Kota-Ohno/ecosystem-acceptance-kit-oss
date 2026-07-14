import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { repositoryNames } from "./manifest.mjs";
import { writeReceipt } from "./receipt.mjs";

const TOOL_COMMANDS = [["git", ["--version"]], ["node", ["--version"]], ["npm", ["--version"]], ["pnpm", ["--version"]], ["cargo", ["--version"]]];

export function createPlan(manifest) {
  return {
    version: 1,
    protocolContractRevision: manifest.protocolContractRevision,
    repositories: manifest.repositories,
    steps: [
      "prerequisites",
      "checkout-pinned-revisions",
      "agent-black-box-check",
      "sol-ledger-install-and-check",
      "evidence-forge-install-and-check",
      "sol-ledger-compatibility",
      "packed-three-product-acceptance",
      "artifact-digest-and-receipt",
    ],
    assurance: {
      executesPinnedRepositoryCode: true,
      networkUsedForCheckoutAndDependencies: true,
      telemetryExported: false,
      sandboxed: false,
      timestampAttested: false,
    },
  };
}

export async function runAcceptance({ manifest, root, outputRoot, workspaceRoot, keepWorkspace = false }) {
  assertDisjointRoots(outputRoot, workspaceRoot);
  const runId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const output = resolve(outputRoot, runId);
  const workspace = resolve(workspaceRoot, runId);
  mkdirSync(output, { recursive: false, mode: 0o700 });
  chmodSync(output, 0o700);
  mkdirSync(workspace, { recursive: false, mode: 0o700 });
  chmodSync(workspace, 0o700);
  const startedAt = new Date().toISOString();
  const steps = [];
  const checkouts = {
    ...Object.fromEntries(repositoryNames.map((name) => [name, join(workspace, name)])),
    solLedgerContract: join(workspace, "solLedgerContract"),
  };

  const step = async (name, command, arguments_, options = {}) => {
    const started = Date.now();
    process.stdout.write(`\n==> ${name}\n`);
    try {
      await execute(command, arguments_, { ...options, redactions: [workspace, output] });
      steps.push({ name, outcome: "passed", durationMs: Date.now() - started });
    } catch (error) {
      steps.push({ name, outcome: "failed", durationMs: Date.now() - started });
      throw error;
    }
  };

  try {
    for (const [command, arguments_] of TOOL_COMMANDS) await step(`prerequisite:${command}`, command, arguments_, { cwd: tmpdir() });
    for (const name of repositoryNames) {
      const entry = manifest.repositories[name];
      mkdirSync(checkouts[name], { mode: 0o700 });
      await step(`checkout:${name}:init`, "git", ["init", "--quiet"], { cwd: checkouts[name] });
      await step(`checkout:${name}:remote`, "git", ["remote", "add", "origin", entry.url], { cwd: checkouts[name] });
      await step(`checkout:${name}:fetch`, "git", ["fetch", "--quiet", "--depth=1", "origin", entry.revision], { cwd: checkouts[name] });
      await step(`checkout:${name}:detach`, "git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: checkouts[name] });
      const actual = (await capture("git", ["rev-parse", "HEAD"], { cwd: checkouts[name] })).trim();
      const dirty = (await capture("git", ["status", "--porcelain"], { cwd: checkouts[name] })).trim();
      if (actual !== entry.revision || dirty) throw new Error(`${name} checkout did not match its clean pinned revision`);
    }
    mkdirSync(checkouts.solLedgerContract, { mode: 0o700 });
    await step("checkout:solLedgerContract:init", "git", ["init", "--quiet"], { cwd: checkouts.solLedgerContract });
    await step("checkout:solLedgerContract:remote", "git", ["remote", "add", "origin", manifest.repositories.solLedger.url], { cwd: checkouts.solLedgerContract });
    await step("checkout:solLedgerContract:fetch", "git", ["fetch", "--quiet", "--depth=1", "origin", manifest.protocolContractRevision], { cwd: checkouts.solLedgerContract });
    await step("checkout:solLedgerContract:detach", "git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: checkouts.solLedgerContract });
    const contractActual = (await capture("git", ["rev-parse", "HEAD"], { cwd: checkouts.solLedgerContract })).trim();
    if (contractActual !== manifest.protocolContractRevision) throw new Error("Sol Ledger contract checkout did not match its pinned revision");

    await step("agent-black-box:install", "pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: checkouts.agentBlackBox });
    await step("agent-black-box:check", "pnpm", ["check"], { cwd: checkouts.agentBlackBox });
    await step("sol-ledger:install", "pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: checkouts.solLedger });
    await step("sol-ledger:test", "pnpm", ["test"], { cwd: checkouts.solLedger });
    await step("sol-ledger:fmt", "cargo", ["fmt", "--check"], { cwd: checkouts.solLedger });
    await step("sol-ledger:clippy", "cargo", ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"], { cwd: checkouts.solLedger });
    await step("sol-ledger:rust-test", "cargo", ["test", "--workspace"], { cwd: checkouts.solLedger });
    await step("evidence-forge:install", "pnpm", ["install", "--frozen-lockfile"], { cwd: checkouts.evidenceForge });
    await step("evidence-forge:check", "pnpm", ["check"], { cwd: checkouts.evidenceForge });
    await step("evidence-forge:sol-ledger-compatibility", "pnpm", ["compatibility:sol-ledger", "--", checkouts.solLedgerContract], { cwd: checkouts.evidenceForge });
    const stackOutput = join(output, "stack");
    await step("ecosystem:packed-acceptance", "pnpm", ["acceptance:packed", "--", "--agent-black-box", checkouts.agentBlackBox, "--sol-ledger", checkouts.solLedger, "--output", stackOutput], { cwd: checkouts.evidenceForge });
    const removedPrivateKeys = removeEphemeralPrivateKeys(stackOutput);
    if (removedPrivateKeys < 1) throw new Error("Packed acceptance did not produce removable ephemeral private keys");

    const artifactPaths = {
      stackReport: join(stackOutput, "report.json"),
      releasePack: join(stackOutput, "packed-release.evidence-pack.json"),
      verificationReceipt: join(stackOutput, "packed-verification-receipt.json"),
    };
    const artifacts = {};
    for (const [name, path] of Object.entries(artifactPaths)) {
      if (!existsSync(path)) throw new Error(`Packed acceptance did not create ${name}`);
      artifacts[name] = { file: `stack/${basename(path)}`, sha256: fileSha256(path) };
    }
    const receipt = writeReceipt(join(output, "acceptance-receipt.json"), {
      version: 1,
      outcome: "verified",
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      revisions: {
        ...Object.fromEntries(repositoryNames.map((name) => [name, manifest.repositories[name].revision])),
        solLedgerContract: manifest.protocolContractRevision,
      },
      steps,
      artifacts,
      assurance: {
        exactRevisionsChecked: true,
        cleanCheckoutsRequired: true,
        productChecksPassed: true,
        packedAcceptancePassed: true,
        ephemeralPrivateKeysRetained: false,
        telemetryExported: false,
        sandboxed: false,
        timestampAttested: false,
      },
    });
    process.stdout.write(`\nVerified receipt: ${receipt.integrity.receiptSha256}\nOutput: ${output}\n`);
    return { output, receipt };
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error), [workspace, output, root]);
    const receiptPath = join(output, "acceptance-receipt.json");
    if (!existsSync(receiptPath)) {
      writeReceipt(receiptPath, {
        version: 1,
        outcome: "failed",
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        revisions: {
          ...Object.fromEntries(repositoryNames.map((name) => [name, manifest.repositories[name].revision])),
          solLedgerContract: manifest.protocolContractRevision,
        },
        steps,
        error: message,
        assurance: { telemetryExported: false, sandboxed: false, timestampAttested: false },
      });
    }
    throw new Error(`Acceptance failed: ${message}`);
  } finally {
    removeEphemeralPrivateKeys(join(output, "stack"));
    if (!keepWorkspace) rmSync(workspace, { recursive: true, force: true });
  }
}

async function execute(command, arguments_, { cwd, redactions = [] } = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { cwd, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => process.stdout.write(redact(String(chunk), redactions)));
    child.stderr.on("data", (chunk) => process.stderr.write(redact(String(chunk), redactions)));
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code ?? signal}`)));
  });
}

async function capture(command, arguments_, { cwd } = {}) {
  let stdout = "";
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", () => {});
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code ?? signal}`)));
  });
  return stdout;
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function assertDisjointRoots(outputRoot, workspaceRoot) {
  const output = resolve(outputRoot);
  const workspace = resolve(workspaceRoot);
  const nested = (parent, child) => {
    const value = relative(parent, child);
    return value === "" || (!value.startsWith("..") && !value.startsWith("/"));
  };
  if (nested(output, workspace) || nested(workspace, output)) {
    throw new Error("Output and workspace roots must be disjoint directories");
  }
}

export function removeEphemeralPrivateKeys(stackOutput) {
  if (!existsSync(stackOutput) || !lstatSync(stackOutput).isDirectory() || lstatSync(stackOutput).isSymbolicLink()) return 0;
  let removed = 0;
  for (const name of readdirSync(stackOutput)) {
    if (!name.endsWith("-private.pem")) continue;
    rmSync(join(stackOutput, name), { force: true });
    removed += 1;
  }
  return removed;
}

function redact(value, paths) {
  return paths.filter(Boolean).sort((a, b) => b.length - a.length).reduce((result, path) => result.replaceAll(path, "[local path]"), value);
}
