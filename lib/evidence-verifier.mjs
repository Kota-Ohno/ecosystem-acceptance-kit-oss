import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  bootstrapProgressTotal, bootstrapWorkspace, canonicalFuturePath, createPinnedCheckout, resolveToolExecutable,
  safeToolEnvironment, verifyPinnedCheckout,
} from "./bootstrap.mjs";
import { registerProcessExitCleanup } from "./child-process.mjs";
import {
  assertDirectoryIdentity, assertFileIdentity, directoryIdentity, executeCommand, hasExactKeys, INSTALL_TIMEOUT_MS,
  pathsOverlap, QUICKSTART_TIMEOUT_MS, runChecked, snapshotInput,
} from "./evidence-runtime.mjs";

export async function verifyRetainedEvidence({
  manifest,
  workspaceRoot,
  directory,
  expectedSha256,
  reporter = () => {},
  bootstrap = bootstrapWorkspace,
  command = executeCommand,
  sourceEnvironment = process.env,
  resolveTool = resolveToolExecutable,
  verifyCheckout = verifyPinnedCheckout,
  createExecutionCheckout = createPinnedCheckout,
  platform = process.platform,
} = {}) {
  if (!manifest || !workspaceRoot || !directory || !/^[0-9a-f]{64}$/u.test(expectedSha256 ?? "")) {
    throw new TypeError("manifest, workspaceRoot, directory, and a lowercase expected SHA-256 are required");
  }
  if (platform === "win32") throw new Error("Evidence verification currently requires macOS or Linux; native Windows is unsupported");
  const workspace = resolve(workspaceRoot);
  const evidenceDirectory = resolve(directory);
  const packetPath = join(evidenceDirectory, "evidence-packet.json");
  const workspaceBoundary = canonicalFuturePath(workspace);
  const evidenceIdentity = directoryIdentity(evidenceDirectory, "Evidence directory");
  if (pathsOverlap(workspaceBoundary, evidenceIdentity.resolved)) {
    throw new Error("Verification workspace and Evidence directory must not overlap");
  }
  if (process.platform !== "win32" && (lstatSync(evidenceIdentity.resolved).mode & 0o077) !== 0) {
    throw new Error("Evidence directory permissions must be private");
  }
  let packetMetadata;
  try { packetMetadata = lstatSync(packetPath); } catch {
    throw new Error("Evidence directory does not contain evidence-packet.json");
  }
  if (!packetMetadata.isFile() || packetMetadata.isSymbolicLink() || packetMetadata.size === 0 ||
      packetMetadata.size > 32 * 1024 * 1024 ||
      (process.platform !== "win32" && (packetMetadata.mode & 0o077) !== 0)) {
    throw new Error("Evidence packet must be a non-empty private regular file no larger than 32 MiB");
  }

  const excludedRoots = [workspaceBoundary, evidenceIdentity.resolved];
  const environment = safeToolEnvironment(sourceEnvironment, excludedRoots);
  const pnpmCommand = resolveTool("pnpm", environment.PATH, excludedRoots);
  const gitCommand = resolveTool("git", environment.PATH, excludedRoots);
  const nodeCommand = resolveTool("node", environment.PATH, excludedRoots);
  if (!pnpmCommand || !gitCommand || !nodeCommand) {
    throw new Error("Evidence verification requires trusted Node.js, pnpm, and Git executables outside its paths");
  }

  const selectedRepositories = ["evidenceForge"];
  const bootstrapSteps = bootstrapProgressTotal(selectedRepositories);
  const total = bootstrapSteps + 5;
  const packetSnapshotRoot = mkdtempSync(join(tmpdir(), "ecosystem-verify-packet-"));
  const removePacketSnapshot = () => rmSync(packetSnapshotRoot, { recursive: true, force: true });
  const unregisterPacketCleanup = registerProcessExitCleanup(removePacketSnapshot);
  let fixedPacketPath;
  try {
    fixedPacketPath = snapshotInput(
      packetPath,
      packetSnapshotRoot,
      "evidence-packet.json",
      32 * 1024 * 1024,
      true,
      { dev: packetMetadata.dev, ino: packetMetadata.ino },
      false,
      "Evidence packet",
    );
  } catch (error) {
    removePacketSnapshot();
    unregisterPacketCleanup();
    throw error;
  }

  let bootstrapReport;
  try {
    bootstrapReport = await bootstrap({
      manifest,
      workspaceRoot: workspace,
      sourceEnvironment,
      requiredTools: ["git", "node", "pnpm"],
      repositorySelection: selectedRepositories,
      reporter: (event) => reporter({ ...event, total }),
    });
  } catch (error) {
    removePacketSnapshot();
    unregisterPacketCleanup();
    throw error;
  }
  const persistentCheckout = bootstrapReport.repositories?.evidenceForge;
  const expectedCheckout = canonicalFuturePath(join(workspace, "evidenceForge"));
  let returnedCheckout;
  try { returnedCheckout = persistentCheckout?.path ? canonicalFuturePath(persistentCheckout.path) : undefined; } catch {}
  if (!persistentCheckout?.path || persistentCheckout.revision !== manifest.repositories.evidenceForge.revision ||
      returnedCheckout !== expectedCheckout) {
    removePacketSnapshot();
    unregisterPacketCleanup();
    throw new Error("Bootstrap did not return the pinned Evidence Forge checkout in the verification workspace");
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

  let executionRoot;
  try {
    executionRoot = mkdtempSync(join(tmpdir(), "ecosystem-verify-"));
  } catch (error) {
    removePacketSnapshot();
    unregisterPacketCleanup();
    throw error;
  }
  const executionPath = join(executionRoot, "evidenceForge");
  const unregisterExecutionCleanup = registerProcessExitCleanup(() => {
    rmSync(executionRoot, { recursive: true, force: true });
    removePacketSnapshot();
  });
  let verification;
  try {
    await step(bootstrapSteps + 1, "evidence-forge:fresh-verifier-checkout", async () => createExecutionCheckout({
      name: "evidenceForge",
      entry: manifest.repositories.evidenceForge,
      destination: executionPath,
      fetchSource: persistentCheckout.path,
      command: (executable, arguments_, options) => command(executable, arguments_, { ...options, timeoutMs: INSTALL_TIMEOUT_MS }),
      gitCommand,
      environment,
    }));
    await step(bootstrapSteps + 2, "evidence-forge:dependencies", async () => runChecked(
      command, pnpmCommand, ["install", "--frozen-lockfile", "--ignore-scripts"],
      { cwd: executionPath, environment, timeoutMs: INSTALL_TIMEOUT_MS }, "Evidence Forge dependency installation",
    ));
    await step(bootstrapSteps + 3, "evidence-forge:build-verifier", async () => runChecked(
      command, pnpmCommand, ["build"],
      { cwd: executionPath, environment, timeoutMs: INSTALL_TIMEOUT_MS }, "Evidence Forge verifier build",
    ));
    verification = await step(bootstrapSteps + 4, "evidence-forge:verify-retained-packet", async () => {
      assertDirectoryIdentity(evidenceDirectory, evidenceIdentity, "Evidence directory", "verification");
      const cli = join(executionPath, "dist", "src", "cli.js");
      const result = await runChecked(
        command, nodeCommand,
        [
          cli, "verify-packet", "--packet", fixedPacketPath, "--expected-sha256", expectedSha256,
          "--error-format", "json",
        ],
        { cwd: executionPath, environment, timeoutMs: QUICKSTART_TIMEOUT_MS }, "Evidence Forge retained packet verification",
      );
      const parsed = parseStandalonePacketVerification(result.stdout, expectedSha256);
      assertFileIdentity(packetPath, packetMetadata, "Evidence packet");
      assertDirectoryIdentity(evidenceDirectory, evidenceIdentity, "Evidence directory", "verification");
      return parsed;
    });
    await step(bootstrapSteps + 5, "evidence-forge:verify-checkout", async () => verifyCheckout({
      name: "evidenceForge", entry: manifest.repositories.evidenceForge, path: executionPath,
      command, gitCommand, environment,
    }));
  } finally {
    rmSync(executionRoot, { recursive: true, force: true });
    removePacketSnapshot();
    unregisterExecutionCleanup();
    unregisterPacketCleanup();
  }
  assertFileIdentity(packetPath, packetMetadata, "Evidence packet");
  assertDirectoryIdentity(evidenceDirectory, evidenceIdentity, "Evidence directory", "verification");
  return {
    version: 1,
    kind: "RetainedEvidenceVerification",
    outcome: "verified",
    directory: evidenceDirectory,
    packetSha256: expectedSha256,
    verification,
    evidenceForge: { revision: persistentCheckout.revision, checkoutAction: persistentCheckout.action },
    assurance: {
      exactRevisionChecked: true,
      expectedDigestArgumentRequired: true,
      dependenciesInstalledWithScriptsDisabled: true,
      repositoryCodeExecuted: true,
      checkoutCleanAfterRun: true,
      disposableExecutionCheckoutRemoved: true,
      kitWritesToEvidenceDirectory: false,
      paidServiceInvokedByKit: false,
    },
  };
}

export function formatRetainedEvidenceVerification(report) {
  return [
    "Retained Evidence: VERIFIED",
    `  Evidence directory: ${report.directory}`,
    `  Packet SHA-256: ${report.packetSha256}`,
    `  Pinned Evidence Forge: ${report.evidenceForge.revision.slice(0, 12)} (${report.evidenceForge.checkoutAction})`,
    "  The Kit did not write to the retained directory; the expected digest came from the command line.",
  ].join("\n");
}

function parseStandalonePacketVerification(source, expectedSha256) {
  let report;
  try { report = JSON.parse(source); } catch { throw new Error("Evidence Forge verifier returned invalid JSON"); }
  if (!hasExactKeys(report, [
    "version", "kind", "outcome", "packetSha256", "sourceSha256", "candidateId", "evidenceId", "timestampAttested",
  ]) || report.version !== 1 || report.kind !== "PortableEvidencePacketVerification" || report.outcome !== "verified" ||
      report.packetSha256 !== expectedSha256 || !/^[0-9a-f]{64}$/u.test(report.sourceSha256 ?? "") ||
      !/^candidate_[a-z0-9_-]{1,128}$/u.test(report.candidateId ?? "") ||
      !/^evidence_[a-z0-9_-]{1,128}$/u.test(report.evidenceId ?? "") || report.timestampAttested !== false) {
    throw new Error("Evidence Forge verifier did not return the verified result contract");
  }
  return report;
}
