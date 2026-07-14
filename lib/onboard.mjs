import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  bootstrapProgressTotal, bootstrapWorkspace, canonicalFuturePath, createPinnedCheckout, resolveToolExecutable,
  safeToolEnvironment, verifyPinnedCheckout,
} from "./bootstrap.mjs";
import { registerProcessExitCleanup, runChildProcess } from "./child-process.mjs";

const INSTALL_TIMEOUT_MS = 5 * 60_000;
const QUICKSTART_TIMEOUT_MS = 2 * 60_000;

export function createAutomaticEvidenceDirectory(root, now = new Date(), identifier = randomUUID()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime()) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(identifier)) {
    throw new TypeError("Automatic Evidence directory requires a valid time and UUID");
  }
  const timestamp = now.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  return resolve(root, `evidence-${timestamp}-${identifier.replaceAll("-", "").slice(0, 8)}`);
}

export async function onboardFirstEvidence({
  manifest,
  workspaceRoot,
  directory,
  source,
  exact,
  exactFile,
  availableAt,
  promoteImmediately = false,
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
  const localFileRequested = source !== undefined || exact !== undefined || exactFile !== undefined || availableAt !== undefined || promoteImmediately;
  const exactInputValid = (typeof exact === "string" && exact.length > 0) !== (typeof exactFile === "string" && exactFile.length > 0);
  if (localFileRequested && (typeof source !== "string" || !source || !exactInputValid ||
      typeof availableAt !== "string" || !availableAt || promoteImmediately !== true)) {
    throw new Error("Local-file onboarding requires --source, exactly one of --exact or --exact-file, --available-at, and --promote-immediately");
  }
  if (localFileRequested && !isRfc3339(availableAt)) {
    throw new Error("--available-at must be an RFC 3339 timestamp such as 2026-07-11T00:00:00Z");
  }
  const sourcePath = localFileRequested ? resolve(source) : undefined;
  const exactFilePath = typeof exactFile === "string" ? resolve(exactFile) : undefined;
  const workspaceBoundary = canonicalFuturePath(workspace);
  const outputBoundary = canonicalFuturePath(output);
  if (pathsOverlap(workspaceBoundary, outputBoundary)) {
    throw new Error("Onboarding workspace and Evidence output directory must not overlap");
  }
  if (existsSync(output)) throw new Error("Evidence output directory already exists; choose a new directory");
  const outputParentIdentity = directoryIdentity(dirname(output), "Evidence output parent");
  if (sourcePath) {
    let sourceMetadata;
    try { sourceMetadata = lstatSync(sourcePath); } catch {
      throw new Error("Local-file onboarding source is unavailable");
    }
    if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
      throw new Error("Local-file onboarding source must be a regular non-symbolic-link file");
    }
    let sourceBoundary;
    try { sourceBoundary = realpathSync(sourcePath); } catch {
      throw new Error("Local-file onboarding source could not be resolved safely");
    }
    if (pathsOverlap(workspaceBoundary, sourceBoundary) || pathsOverlap(outputBoundary, sourceBoundary)) {
      throw new Error("Onboarding source, workspace, and Evidence output must not overlap");
    }
  }
  if (platform === "win32") throw new Error("Onboarding currently requires macOS or Linux; native Windows is unsupported");

  const excludedRoots = [workspaceBoundary, outputBoundary];
  const environment = safeToolEnvironment(sourceEnvironment, excludedRoots);
  const pnpmCommand = resolveTool("pnpm", environment.PATH, excludedRoots);
  const gitCommand = resolveTool("git", environment.PATH, excludedRoots);
  const nodeCommand = resolveTool("node", environment.PATH, excludedRoots);
  if (!pnpmCommand || !gitCommand || !nodeCommand) {
    throw new Error("Onboarding requires trusted Node.js, pnpm, and Git executables outside the workspace");
  }

  const selectedRepositories = ["evidenceForge"];
  const bootstrapSteps = bootstrapProgressTotal(selectedRepositories);
  const total = bootstrapSteps + 5;
  const sourceSnapshotRoot = sourcePath ? mkdtempSync(join(tmpdir(), "ecosystem-onboard-source-")) : undefined;
  let fixedSourcePath;
  let fixedExactPath;
  try {
    fixedSourcePath = sourcePath ? snapshotInput(sourcePath, sourceSnapshotRoot, "caller-source.bin", 16 * 1024 * 1024, false) : undefined;
    fixedExactPath = exactFilePath ? snapshotInput(exactFilePath, sourceSnapshotRoot, "caller-exact.txt", 64 * 1024, true) : undefined;
  } catch (error) {
    if (sourceSnapshotRoot) rmSync(sourceSnapshotRoot, { recursive: true, force: true });
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
    if (sourceSnapshotRoot) rmSync(sourceSnapshotRoot, { recursive: true, force: true });
    throw error;
  }
  const persistentCheckout = bootstrapReport.repositories?.evidenceForge;
  if (!persistentCheckout?.path || persistentCheckout.revision !== manifest.repositories.evidenceForge.revision) {
    if (sourceSnapshotRoot) rmSync(sourceSnapshotRoot, { recursive: true, force: true });
    throw new Error("Bootstrap did not return the pinned Evidence Forge checkout");
  }
  const expectedCheckout = canonicalFuturePath(join(workspace, "evidenceForge"));
  if (canonicalFuturePath(persistentCheckout.path) !== expectedCheckout) {
    if (sourceSnapshotRoot) rmSync(sourceSnapshotRoot, { recursive: true, force: true });
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
  const unregisterExitCleanup = registerProcessExitCleanup(() => {
    rmSync(executionRoot, { recursive: true, force: true });
    if (sourceSnapshotRoot) rmSync(sourceSnapshotRoot, { recursive: true, force: true });
  });
  let evidence;
  try {
    await step(bootstrapSteps + 1, "evidence-forge:fresh-execution-checkout", async () => createExecutionCheckout({
      name: "evidenceForge",
      entry: manifest.repositories.evidenceForge,
      destination: executionPath,
      fetchSource: persistentCheckout.path,
      command: (executable, arguments_, options) => command(executable, arguments_, { ...options, timeoutMs: INSTALL_TIMEOUT_MS }),
      gitCommand,
      environment,
    }));
    await step(bootstrapSteps + 2, "evidence-forge:dependencies", async () => runChecked(
      command,
      pnpmCommand,
      ["install", "--frozen-lockfile", "--ignore-scripts"],
      { cwd: executionPath, environment, timeoutMs: INSTALL_TIMEOUT_MS },
      "Evidence Forge dependency installation",
    ));
    evidence = await step(bootstrapSteps + 3, localFileRequested ? "evidence-forge:local-file" : "evidence-forge:first-evidence", async () => {
      assertDirectoryIdentity(dirname(output), outputParentIdentity, "Evidence output parent");
      const arguments_ = localFileRequested
        ? [
            "--silent", "forge", "--source", fixedSourcePath,
            ...(fixedExactPath ? ["--exact-file", fixedExactPath] : ["--exact", exact]),
            "--available-at", availableAt, "--directory", output, "--promote-immediately",
          ]
        : ["--silent", "quickstart", "--directory", output];
      const result = await runChecked(
        command,
        pnpmCommand,
        arguments_,
        { cwd: executionPath, environment, timeoutMs: QUICKSTART_TIMEOUT_MS },
        localFileRequested ? "Evidence Forge local-file workflow" : "Evidence Forge quickstart",
      );
      return parseEvidenceResult(result.stdout, localFileRequested ? "local_file" : "tutorial");
    });
    await step(bootstrapSteps + 4, "evidence-forge:verify-packet", async () => {
      verifyArtifacts(output, evidence);
      const cli = join(executionPath, "dist", "src", "cli.js");
      const cliMetadata = lstatSync(cli);
      if (!cliMetadata.isFile() || cliMetadata.isSymbolicLink()) throw new Error("Evidence Forge verifier is unavailable after the workflow");
      const verificationResult = await runChecked(
        command,
        nodeCommand,
        [cli, "verify-packet", "--packet", join(output, evidence.artifacts.packet), "--expected-sha256", evidence.packetSha256],
        { cwd: executionPath, environment, timeoutMs: QUICKSTART_TIMEOUT_MS },
        "Evidence Forge packet verification",
      );
      verifyArtifactContents(output, evidence, parsePacketVerification(verificationResult.stdout, evidence));
    });
    await step(bootstrapSteps + 5, "evidence-forge:verify-checkout", async () => {
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
      if (sourceSnapshotRoot) rmSync(sourceSnapshotRoot, { recursive: true, force: true });
      removed = true;
    } finally {
      if (removed) unregisterExitCleanup();
    }
  }

  const common = {
    outcome: "first_evidence_ready",
    workspace,
    directory: output,
    evidenceForge: { revision: persistentCheckout.revision, checkoutAction: persistentCheckout.action },
  };
  const assurance = {
    exactRevisionChecked: true,
    dependenciesInstalledWithScriptsDisabled: true,
    repositoryCodeExecuted: true,
    checkoutCleanAfterRun: true,
    disposableExecutionCheckoutRemoved: true,
    existingEvidenceFilesOverwritten: false,
    networkMayBeUsedForCheckoutOrPackages: true,
    paidServiceInvokedByKit: false,
  };
  return localFileRequested
    ? {
        version: 2, ...common, workflow: "local_file", scope: {
          repositoriesChecked: ["evidenceForge"], allRepositoriesChecked: false,
        }, evidence,
        assurance: {
          ...assurance, callerSourceUsed: true, promotionPreauthorized: true, sourceOrExactPrintedByKit: false,
        },
      }
    : { version: 1, ...common, quickstart: evidence, assurance };
}

export function formatOnboard(report) {
  const localFile = report.workflow === "local_file";
  const evidence = localFile ? report.evidence : report.quickstart;
  return [
    "Verified Evidence: READY",
    `  Workflow: ${localFile ? "caller-selected local file" : "local tutorial"}`,
    `  Evidence directory: ${report.directory}`,
    `  Pinned Evidence Forge: ${report.evidenceForge.revision.slice(0, 12)} (${report.evidenceForge.checkoutAction})`,
    ...(localFile ? ["  Scope: Evidence Forge only; other workspace repositories were not checked."] : []),
    `  Packet: ${evidence.artifacts.packet}`,
    `  Packet SHA-256: ${evidence.packetSha256}`,
    "  Dependencies were installed with lifecycle scripts disabled.",
    localFile
      ? "  Immediate promotion was preauthorized; inspect-first workflows still use capture then promote."
      : "  The pinned Evidence Forge tutorial quickstart was executed explicitly by onboard.",
    "  Next: inspect verified-evidence.json and keep the packet SHA-256 independently.",
  ].join("\n");
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

function isRfc3339(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function snapshotInput(sourcePath, executionRoot, leaf, maxBytes, privateModeRequired) {
  let descriptor;
  try {
    descriptor = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > maxBytes ||
        (privateModeRequired && process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) throw new Error();
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    const afterRead = fstatSync(descriptor);
    if (length > maxBytes || afterRead.size !== metadata.size || afterRead.mtimeMs !== metadata.mtimeMs ||
        afterRead.ctimeMs !== metadata.ctimeMs) throw new Error();
    const snapshot = join(executionRoot, leaf);
    writeFileSync(snapshot, bytes.subarray(0, length), { mode: 0o600, flag: "wx" });
    return snapshot;
  } catch {
    throw new Error("Local-file onboarding source could not be fixed safely for execution");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function directoryIdentity(path, label) {
  try {
    const resolved = realpathSync(path);
    const metadata = lstatSync(resolved);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error();
    return { resolved, dev: metadata.dev, ino: metadata.ino };
  } catch {
    throw new Error(`${label} must be an existing real directory`);
  }
}

function assertDirectoryIdentity(path, expected, label) {
  const current = directoryIdentity(path, label);
  if (current.resolved !== expected.resolved || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`${label} identity changed during onboarding`);
  }
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
  if (/already exists|eexist/u.test(details) && label.startsWith("Evidence Forge")) {
    return `${label} requires a new --directory; the existing path was left unchanged`;
  }
  return `${label} failed with exit ${String(result.code ?? result.signal)}`;
}

function parseEvidenceResult(source, workflow) {
  let report;
  try { report = JSON.parse(source); } catch { throw new Error("Evidence Forge workflow returned invalid JSON"); }
  const expectedKind = workflow === "local_file" ? "EvidenceForgeLocalFileResult" : "EvidenceForgeQuickstartResult";
  const localAssuranceValid = workflow !== "local_file" || report?.assurance?.promotionPreauthorized === true;
  const expectedAssuranceKeys = workflow === "local_file"
    ? ["localOnly", "promotionPreauthorized", "existingFilesOverwritten", "rawSourcePrinted", "timestampAttested"]
    : ["localOnly", "existingFilesOverwritten", "rawSourcePrinted", "timestampAttested"];
  const expectedStages = workflow === "local_file"
    ? [
        { name: "capture", status: "observation" }, { name: "promote", status: "evidence" },
        { name: "packet", status: "portable" }, { name: "verify", status: "verified" },
      ]
    : [
        { name: "capture", outputKind: "EvidenceCandidate", status: "observation" },
        { name: "promote", outputKind: "VerifiedEvidence", status: "evidence" },
        { name: "packet", outputKind: "PortableEvidencePacket" }, { name: "verify", outcome: "verified" },
      ];
  if (!hasExactKeys(report, ["version", "kind", "outcome", "stages", "artifacts", "candidateId", "evidenceId", "packetSha256", "assurance"]) ||
      !hasExactKeys(report.assurance, expectedAssuranceKeys) || report.version !== 1 || report.kind !== expectedKind ||
      report.outcome !== "verified" || !isDeepStrictEqual(report.stages, expectedStages) ||
      report?.assurance?.localOnly !== true || report?.assurance?.existingFilesOverwritten !== false ||
      report?.assurance?.rawSourcePrinted !== false || report?.assurance?.timestampAttested !== false ||
      !localAssuranceValid || !/^candidate_[a-z0-9_-]{1,128}$/u.test(report?.candidateId ?? "") ||
      !/^evidence_[a-z0-9_-]{1,128}$/u.test(report?.evidenceId ?? "") || typeof report?.artifacts?.packet !== "string" ||
      !/^[0-9a-f]{64}$/u.test(report?.packetSha256)) {
    throw new Error("Evidence Forge workflow did not return the verified result contract");
  }
  return report;
}

function hasExactKeys(value, keys) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function parsePacketVerification(source, evidence) {
  let report;
  try { report = JSON.parse(source); } catch { throw new Error("Evidence Forge verifier returned invalid JSON"); }
  if (!hasExactKeys(report, [
    "version", "kind", "outcome", "packetSha256", "sourceSha256", "candidateId", "evidenceId", "timestampAttested",
  ]) || report.version !== 1 || report.kind !== "PortableEvidencePacketVerification" || report.outcome !== "verified" ||
      report.packetSha256 !== evidence.packetSha256 || report.candidateId !== evidence.candidateId ||
      report.evidenceId !== evidence.evidenceId || !/^[0-9a-f]{64}$/u.test(report.sourceSha256 ?? "") ||
      report.timestampAttested !== false) {
    throw new Error("Evidence Forge verifier did not return the verified result contract");
  }
  return report;
}

function verifyArtifactContents(directory, result, verification) {
  const root = canonicalFuturePath(directory);
  const readJson = (name) => {
    try { return JSON.parse(readFileSync(join(root, result.artifacts[name]), "utf8")); } catch {
      throw new Error(`Evidence Forge ${name} artifact is invalid`);
    }
  };
  const candidate = readJson("candidate");
  const evidence = readJson("evidence");
  const packet = readJson("packet");
  const persistedVerification = readJson("verification");
  if (candidate?.kind !== "EvidenceCandidate" || candidate?.id !== result.candidateId ||
      evidence?.kind !== "VerifiedEvidence" || evidence?.id !== result.evidenceId ||
      evidence?.candidateId !== result.candidateId || packet?.kind !== "PortableEvidencePacket" ||
      packet?.candidate?.id !== result.candidateId || packet?.evidence?.id !== result.evidenceId ||
      packet?.source?.sha256 !== verification.sourceSha256 || candidate?.snapshot?.sha256 !== verification.sourceSha256 ||
      evidence?.snapshot?.sha256 !== verification.sourceSha256 || !isDeepStrictEqual(persistedVerification, verification)) {
    throw new Error("Evidence Forge artifacts do not match the independently verified packet");
  }
}

function verifyArtifacts(directory, evidence) {
  const artifacts = evidence.artifacts;
  const root = canonicalFuturePath(directory);
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Evidence Forge workflow did not create a real output directory");
  }
  if (process.platform !== "win32" && (rootMetadata.mode & 0o077) !== 0) {
    throw new Error("Evidence Forge workflow output directory permissions are not private");
  }
  const expected = evidence.kind === "EvidenceForgeLocalFileResult"
    ? {
        candidate: "candidate.json", evidence: "verified-evidence.json", packet: "evidence-packet.json",
        verification: "packet-verification.json", result: "forge-result.json",
      }
    : {
        source: "source.txt", candidate: "candidate.json", evidence: "verified-evidence.json",
        packet: "evidence-packet.json", verification: "packet-verification.json", result: "quickstart-result.json",
      };
  if (!artifacts || Object.keys(artifacts).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([name, leaf]) => artifacts[name] !== leaf)) {
    throw new Error("Evidence Forge workflow returned an invalid artifact inventory");
  }
  for (const name of Object.keys(expected)) {
    const leaf = artifacts[name];
    if (leaf !== basename(leaf) || leaf === "." || leaf === "..") throw new Error("Evidence Forge workflow returned an unsafe artifact name");
    const path = join(root, leaf);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 32 * 1024 * 1024) {
      throw new Error("Evidence Forge workflow returned an unsafe artifact");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("Evidence Forge workflow artifact permissions are not private");
    }
  }
  let persisted;
  try { persisted = JSON.parse(readFileSync(join(root, artifacts.result), "utf8")); } catch {
    throw new Error("Evidence Forge persisted workflow result is invalid");
  }
  if (!isDeepStrictEqual(persisted, evidence)) {
    throw new Error("Evidence Forge persisted workflow result does not match process output");
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
