import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { repositoryNames } from "./manifest.mjs";
import { writeReceipt } from "./receipt.mjs";
import { runChildProcess } from "./child-process.mjs";

const TOOL_COMMANDS = [["git", ["--version"]], ["node", ["--version"]], ["npm", ["--version"]], ["pnpm", ["--version"]], ["cargo", ["--version"]]];
const COMMAND_TIMEOUT_MS = 10 * 60_000;

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
  const executionEnvironment = createExecutionEnvironment(workspace);
  const totalSteps = 33;
  let stepPosition = 0;
  const startedAt = new Date().toISOString();
  const steps = [];
  const checkouts = {
    ...Object.fromEntries(repositoryNames.map((name) => [name, join(workspace, name)])),
    solLedgerContract: join(workspace, "solLedgerContract"),
  };

  const step = async (name, command, arguments_, options = {}) => {
    const started = Date.now();
    stepPosition += 1;
    process.stdout.write(`\n[${String(stepPosition).padStart(2, "0")}/${String(totalSteps)}] start ${name}\n`);
    try {
      await execute(command, arguments_, { environment: executionEnvironment, ...options, redactions: [workspace, output] });
      const durationMs = Date.now() - started;
      steps.push({ name, outcome: "passed", durationMs });
      process.stdout.write(`[${String(stepPosition).padStart(2, "0")}/${String(totalSteps)}] done ${name} (${(durationMs / 1000).toFixed(1)}s)\n`);
    } catch (error) {
      const durationMs = Date.now() - started;
      steps.push({ name, outcome: "failed", durationMs });
      process.stdout.write(`[${String(stepPosition).padStart(2, "0")}/${String(totalSteps)}] failed ${name} (${(durationMs / 1000).toFixed(1)}s)\n`);
      throw error;
    }
  };

  try {
    for (const [command, arguments_] of TOOL_COMMANDS) await step(`prerequisite:${command}`, command, arguments_, { cwd: tmpdir(), environment: process.env });
    for (const name of repositoryNames) {
      const entry = manifest.repositories[name];
      mkdirSync(checkouts[name], { mode: 0o700 });
      await step(`checkout:${name}:init`, "git", ["init", "--quiet"], { cwd: checkouts[name], environment: process.env });
      await step(`checkout:${name}:remote`, "git", ["remote", "add", "origin", entry.url], { cwd: checkouts[name], environment: process.env });
      await step(`checkout:${name}:fetch`, "git", ["fetch", "--quiet", "--depth=1", "origin", entry.revision], { cwd: checkouts[name], environment: process.env });
      await step(`checkout:${name}:detach`, "git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: checkouts[name], environment: process.env });
      const actual = (await capture("git", ["rev-parse", "HEAD"], { cwd: checkouts[name] })).trim();
      const dirty = (await capture("git", ["status", "--porcelain"], { cwd: checkouts[name] })).trim();
      if (actual !== entry.revision || dirty) throw new Error(`${name} checkout did not match its clean pinned revision`);
    }
    mkdirSync(checkouts.solLedgerContract, { mode: 0o700 });
    await step("checkout:solLedgerContract:init", "git", ["init", "--quiet"], { cwd: checkouts.solLedgerContract, environment: process.env });
    await step("checkout:solLedgerContract:remote", "git", ["remote", "add", "origin", manifest.repositories.solLedger.url], { cwd: checkouts.solLedgerContract, environment: process.env });
    await step("checkout:solLedgerContract:fetch", "git", ["fetch", "--quiet", "--depth=1", "origin", manifest.protocolContractRevision], { cwd: checkouts.solLedgerContract, environment: process.env });
    await step("checkout:solLedgerContract:detach", "git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: checkouts.solLedgerContract, environment: process.env });
    const contractActual = (await capture("git", ["rev-parse", "HEAD"], { cwd: checkouts.solLedgerContract })).trim();
    if (contractActual !== manifest.protocolContractRevision) throw new Error("Sol Ledger contract checkout did not match its pinned revision");

    await step("agent-black-box:install", "pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: checkouts.agentBlackBox });
    await step("agent-black-box:check", "pnpm", ["check"], { cwd: checkouts.agentBlackBox });
    await step("agent-black-box:protocol-compatibility", "pnpm", ["check:protocol", "--", checkouts.solLedgerContract], { cwd: checkouts.agentBlackBox });
    await step("sol-ledger:install", "pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: checkouts.solLedger });
    await step("sol-ledger:test", "pnpm", ["test"], { cwd: checkouts.solLedger });
    await step("sol-ledger:fmt", "cargo", ["fmt", "--check"], { cwd: checkouts.solLedger });
    await step("sol-ledger:clippy", "cargo", ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"], { cwd: checkouts.solLedger });
    await step("sol-ledger:rust-test", "cargo", ["test", "--workspace"], { cwd: checkouts.solLedger });
    await step("evidence-forge:install", "pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: checkouts.evidenceForge });
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

export async function execute(command, arguments_, { cwd, redactions = [], environment = process.env, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const result = await runChildProcess(command, arguments_, {
    cwd,
    environment,
    environmentOverrides: { CI: "1" },
    timeoutMs,
    stdoutLimit: 0,
    stderrLimit: 0,
    onStdout: (chunk) => process.stdout.write(redact(String(chunk), redactions)),
    onStderr: (chunk) => process.stderr.write(redact(String(chunk), redactions)),
  });
  if (result.spawnError) throw result.spawnError;
  if (result.timedOut) throw new Error(`${command} timed out after ${String(timeoutMs)} ms`);
  if (result.code !== 0) throw new Error(`${command} exited with ${result.code ?? result.signal}`);
}

async function capture(command, arguments_, { cwd } = {}) {
  const result = await runChildProcess(command, arguments_, {
    cwd,
    timeoutMs: 30_000,
    stdoutLimit: 1024 * 1024,
    stderrLimit: 16 * 1024,
    terminateOnOutputLimit: ["stdout"],
  });
  if (result.spawnError) throw result.spawnError;
  if (result.timedOut) throw new Error(`${command} timed out`);
  if (result.stdoutExceeded) throw new Error(`${command} output exceeded limit`);
  if (result.code !== 0) throw new Error(`${command} exited with ${result.code ?? result.signal}`);
  return result.stdout;
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
  for (const entry of readdirSync(stackOutput, { withFileTypes: true })) {
    const path = join(stackOutput, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) removed += removeEphemeralPrivateKeys(path);
    else if (entry.isFile() && entry.name.endsWith("-private.pem")) {
      rmSync(path, { force: true });
      removed += 1;
    }
  }
  return removed;
}

export function createExecutionEnvironment(workspace, sourceEnvironment = process.env) {
  const home = join(workspace, ".isolated-home");
  const temporary = join(workspace, ".tmp");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const allowed = [
    "PATH", "LANG", "LC_ALL", "TERM", "RUSTUP_HOME", "CARGO_HOME", "COREPACK_HOME",
    "XDG_CACHE_HOME", "SYSTEMROOT", "WINDIR", "LOCALAPPDATA",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "NPM_CONFIG_CAFILE",
    "CARGO_HTTP_CAINFO", "GIT_SSL_CAINFO",
  ];
  const inherited = Object.fromEntries(
    allowed.filter((name) => sourceEnvironment[name] !== undefined).map((name) => [name, sourceEnvironment[name]]),
  );
  const hostHome = sourceEnvironment.HOME;
  if (inherited.RUSTUP_HOME === undefined && hostHome && existsSync(join(hostHome, ".rustup"))) {
    inherited.RUSTUP_HOME = join(hostHome, ".rustup");
  }
  if (inherited.CARGO_HOME === undefined && hostHome && existsSync(join(hostHome, ".cargo"))) {
    inherited.CARGO_HOME = join(hostHome, ".cargo");
  }
  if (inherited.COREPACK_HOME === undefined) {
    const corepackHomes = [
      sourceEnvironment.XDG_CACHE_HOME && join(sourceEnvironment.XDG_CACHE_HOME, "node", "corepack"),
      hostHome && join(hostHome, ".cache", "node", "corepack"),
      hostHome && join(hostHome, "Library", "Caches", "node", "corepack"),
      sourceEnvironment.LOCALAPPDATA && join(sourceEnvironment.LOCALAPPDATA, "node", "corepack"),
    ].filter(Boolean);
    inherited.COREPACK_HOME = corepackHomes.find((path) => existsSync(path));
    if (inherited.COREPACK_HOME === undefined) delete inherited.COREPACK_HOME;
  }
  return Object.fromEntries([
    ...Object.entries(inherited),
    ["HOME", home], ["TMPDIR", temporary], ["CI", "1"], ["NO_COLOR", "1"],
  ]);
}

function redact(value, paths) {
  return paths.filter(Boolean).sort((a, b) => b.length - a.length).reduce((result, path) => result.replaceAll(path, "[local path]"), value);
}
