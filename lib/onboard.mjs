import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  bootstrapWorkspace, canonicalFuturePath, createPinnedCheckout, resolveToolExecutable, safeToolEnvironment, verifyPinnedCheckout,
} from "./bootstrap.mjs";
import { registerProcessExitCleanup, runChildProcess } from "./child-process.mjs";

const INSTALL_TIMEOUT_MS = 5 * 60_000;
const QUICKSTART_TIMEOUT_MS = 2 * 60_000;

export async function onboardFirstEvidence({
  manifest,
  workspaceRoot,
  directory,
  reporter = () => {},
  bootstrap = bootstrapWorkspace,
  command = executeCommand,
  sourceEnvironment = process.env,
  resolveTool = resolveToolExecutable,
  verifyCheckout = verifyPinnedCheckout,
  createExecutionCheckout = createPinnedCheckout,
  platform = process.platform,
} = {}) {
  if (!manifest || !workspaceRoot || !directory) throw new TypeError("manifest, workspaceRoot, and directory are required");
  const workspace = resolve(workspaceRoot);
  const output = resolve(directory);
  const workspaceBoundary = canonicalFuturePath(workspace);
  const outputBoundary = canonicalFuturePath(output);
  if (pathsOverlap(workspaceBoundary, outputBoundary)) {
    throw new Error("Onboarding workspace and Evidence output directory must not overlap");
  }
  if (existsSync(output)) throw new Error("Evidence output directory already exists; choose a new directory");
  if (platform === "win32") throw new Error("Onboarding currently requires macOS or Linux; native Windows is unsupported");

  const excludedRoots = [workspaceBoundary, outputBoundary];
  const environment = safeToolEnvironment(sourceEnvironment, excludedRoots);
  const pnpmCommand = resolveTool("pnpm", environment.PATH, excludedRoots);
  const gitCommand = resolveTool("git", environment.PATH, excludedRoots);
  const nodeCommand = resolveTool("node", environment.PATH, excludedRoots);
  if (!pnpmCommand || !gitCommand || !nodeCommand) {
    throw new Error("Onboarding requires trusted Node.js, pnpm, and Git executables outside the workspace");
  }

  const total = 10;
  const bootstrapReport = await bootstrap({
    manifest,
    workspaceRoot: workspace,
    sourceEnvironment,
    requiredTools: ["git", "node", "pnpm"],
    reporter: (event) => reporter({ ...event, total }),
  });
  const persistentCheckout = bootstrapReport.repositories?.evidenceForge;
  if (!persistentCheckout?.path || persistentCheckout.revision !== manifest.repositories.evidenceForge.revision) {
    throw new Error("Bootstrap did not return the pinned Evidence Forge checkout");
  }
  const expectedCheckout = canonicalFuturePath(join(workspace, "evidenceForge"));
  if (canonicalFuturePath(persistentCheckout.path) !== expectedCheckout) {
    throw new Error("Bootstrap returned Evidence Forge outside the onboarding workspace");
  }

  const step = async (position, name, operation) => {
    const started = Date.now();
    reporter({ state: "start", position, total, name });
    try {
      const value = await operation();
      reporter({ state: "done", position, total, name, durationMs: Date.now() - started });
      return value;
    } catch (error) {
      reporter({ state: "failed", position, total, name, durationMs: Date.now() - started });
      throw error;
    }
  };

  const executionRoot = mkdtempSync(join(tmpdir(), "ecosystem-onboard-"));
  const executionPath = join(executionRoot, "evidenceForge");
  const unregisterExitCleanup = registerProcessExitCleanup(() => rmSync(executionRoot, { recursive: true, force: true }));
  let quickstart;
  try {
    await step(6, "evidence-forge:fresh-execution-checkout", async () => createExecutionCheckout({
      name: "evidenceForge",
      entry: manifest.repositories.evidenceForge,
      destination: executionPath,
      fetchSource: persistentCheckout.path,
      command: (executable, arguments_, options) => command(executable, arguments_, { ...options, timeoutMs: INSTALL_TIMEOUT_MS }),
      gitCommand,
      environment,
    }));
    await step(7, "evidence-forge:dependencies", async () => runChecked(
      command,
      pnpmCommand,
      ["install", "--frozen-lockfile", "--ignore-scripts"],
      { cwd: executionPath, environment, timeoutMs: INSTALL_TIMEOUT_MS },
      "Evidence Forge dependency installation",
    ));
    quickstart = await step(8, "evidence-forge:first-evidence", async () => {
      const result = await runChecked(
        command,
        pnpmCommand,
        ["--silent", "quickstart", "--directory", output],
        { cwd: executionPath, environment, timeoutMs: QUICKSTART_TIMEOUT_MS },
        "Evidence Forge quickstart",
      );
      return parseQuickstart(result.stdout);
    });
    await step(9, "evidence-forge:verify-packet", async () => {
      verifyArtifacts(output, quickstart);
      const cli = join(executionPath, "dist", "src", "cli.js");
      const cliMetadata = lstatSync(cli);
      if (!cliMetadata.isFile() || cliMetadata.isSymbolicLink()) throw new Error("Evidence Forge verifier is unavailable after quickstart");
      await runChecked(
        command,
        nodeCommand,
        [cli, "verify-packet", "--packet", join(output, quickstart.artifacts.packet), "--expected-sha256", quickstart.packetSha256],
        { cwd: executionPath, environment, timeoutMs: QUICKSTART_TIMEOUT_MS },
        "Evidence Forge packet verification",
      );
    });
    await step(10, "evidence-forge:verify-checkout", async () => {
      await verifyCheckout({
        name: "evidenceForge",
        entry: manifest.repositories.evidenceForge,
        path: executionPath,
        command,
        gitCommand,
        environment,
      });
    });
  } finally {
    let removed = false;
    try {
      rmSync(executionRoot, { recursive: true, force: true });
      removed = true;
    } finally {
      if (removed) unregisterExitCleanup();
    }
  }

  return {
    version: 1,
    outcome: "first_evidence_ready",
    workspace,
    directory: output,
    evidenceForge: { revision: persistentCheckout.revision, checkoutAction: persistentCheckout.action },
    quickstart,
    assurance: {
      exactRevisionChecked: true,
      dependenciesInstalledWithScriptsDisabled: true,
      repositoryCodeExecuted: true,
      checkoutCleanAfterRun: true,
      disposableExecutionCheckoutRemoved: true,
      existingEvidenceFilesOverwritten: false,
      networkMayBeUsedForCheckoutOrPackages: true,
      paidServiceInvokedByKit: false,
    },
  };
}

export function formatOnboard(report) {
  return [
    "First verified Evidence: READY",
    `  Evidence directory: ${report.directory}`,
    `  Pinned Evidence Forge: ${report.evidenceForge.revision.slice(0, 12)} (${report.evidenceForge.checkoutAction})`,
    `  Packet: ${report.quickstart.artifacts.packet}`,
    `  Packet SHA-256: ${report.quickstart.packetSha256}`,
    "  Dependencies were installed with lifecycle scripts disabled.",
    "  The pinned Evidence Forge quickstart was executed explicitly by onboard.",
    "  Next: inspect verified-evidence.json and keep the packet SHA-256 independently.",
  ].join("\n");
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

async function runChecked(command, executable, arguments_, options, label) {
  const result = await command(executable, arguments_, options);
  if (result.spawnError) throw new Error(`${label} could not start`);
  if (result.timedOut) throw new Error(`${label} timed out`);
  if (result.stdoutExceeded || result.stderrExceeded) throw new Error(`${label} output exceeded its safety limit`);
  if (result.code !== 0) throw new Error(classifyFailure(label, result));
  return result;
}

function classifyFailure(label, result) {
  const details = String(result.stderr).toLowerCase();
  if (/err_pnpm_outdated_lockfile|frozen[- ]lockfile/u.test(details)) {
    return `${label} rejected the pinned lockfile; restore the exact checkout and retry`;
  }
  if (/err_pnpm_unsupported_engine|unsupported (?:environment|engine)|incompatible.*node/u.test(details)) {
    return `${label} requires a supported Node.js and pnpm version; run pnpm doctor`;
  }
  if (/err_pnpm_fetch_401|401 unauthorized|authentication required|authorization failed/u.test(details)) {
    return `${label} could not authenticate to the package registry; verify registry credentials`;
  }
  if (/err_pnpm_meta_fetch_fail|enotfound|econnrefused|etimedout|certificate|\bssl\b|\btls\b/u.test(details)) {
    return `${label} could not reach the package registry; check network and TLS settings`;
  }
  if (/already exists|eexist/u.test(details) && label === "Evidence Forge quickstart") {
    return `${label} requires a new --directory; the existing path was left unchanged`;
  }
  return `${label} failed with exit ${String(result.code ?? result.signal)}`;
}

function parseQuickstart(source) {
  let report;
  try { report = JSON.parse(source); } catch { throw new Error("Evidence Forge quickstart returned invalid JSON"); }
  if (report?.version !== 1 || report?.kind !== "EvidenceForgeQuickstartResult" || report?.outcome !== "verified" ||
      report?.assurance?.localOnly !== true || report?.assurance?.existingFilesOverwritten !== false ||
      typeof report?.artifacts?.packet !== "string" || !/^[0-9a-f]{64}$/u.test(report?.packetSha256)) {
    throw new Error("Evidence Forge quickstart did not return the verified result contract");
  }
  return report;
}

function verifyArtifacts(directory, quickstart) {
  const artifacts = quickstart.artifacts;
  const root = canonicalFuturePath(directory);
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Evidence Forge quickstart did not create a real output directory");
  }
  if (process.platform !== "win32" && (rootMetadata.mode & 0o077) !== 0) {
    throw new Error("Evidence Forge quickstart output directory permissions are not private");
  }
  const expected = {
    source: "source.txt",
    candidate: "candidate.json",
    evidence: "verified-evidence.json",
    packet: "evidence-packet.json",
    verification: "packet-verification.json",
    result: "quickstart-result.json",
  };
  if (!artifacts || Object.keys(artifacts).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([name, leaf]) => artifacts[name] !== leaf)) {
    throw new Error("Evidence Forge quickstart returned an invalid artifact inventory");
  }
  for (const name of Object.keys(expected)) {
    const leaf = artifacts[name];
    if (leaf !== basename(leaf) || leaf === "." || leaf === "..") throw new Error("Evidence Forge quickstart returned an unsafe artifact name");
    const path = join(root, leaf);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 32 * 1024 * 1024) {
      throw new Error("Evidence Forge quickstart returned an unsafe artifact");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("Evidence Forge quickstart artifact permissions are not private");
    }
  }
  let persisted;
  try { persisted = JSON.parse(readFileSync(join(root, artifacts.result), "utf8")); } catch {
    throw new Error("Evidence Forge persisted quickstart result is invalid");
  }
  if (!isDeepStrictEqual(persisted, quickstart)) {
    throw new Error("Evidence Forge persisted quickstart result does not match process output");
  }
}

async function executeCommand(command, arguments_, { cwd, environment, timeoutMs } = {}) {
  return runChildProcess(command, arguments_, {
    cwd,
    environment,
    timeoutMs,
    killGraceMs: 2_000,
    stdoutLimit: 256 * 1024,
    stderrLimit: 128 * 1024,
    terminateOnOutputLimit: true,
  });
}
