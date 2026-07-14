import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { runChildProcess } from "./child-process.mjs";

export const INSTALL_TIMEOUT_MS = 5 * 60_000;
export const QUICKSTART_TIMEOUT_MS = 2 * 60_000;

class CitationInputError extends Error {}

export function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

export function snapshotInput(
  sourcePath,
  executionRoot,
  leaf,
  maxBytes,
  privateModeRequired,
  expectedIdentity,
  exactTextRequired = false,
  inputLabel = "Local-file onboarding source",
) {
  let descriptor;
  try {
    descriptor = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error();
    if (exactTextRequired && (metadata.size === 0 || metadata.size > maxBytes)) throw new CitationInputError();
    if (metadata.size === 0 || metadata.size > maxBytes ||
        (privateModeRequired && process.platform !== "win32" && (metadata.mode & 0o077) !== 0) ||
        (expectedIdentity && (metadata.dev !== expectedIdentity.dev || metadata.ino !== expectedIdentity.ino))) throw new Error();
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    const afterRead = fstatSync(descriptor);
    if (exactTextRequired && length > maxBytes) throw new CitationInputError();
    if (length > maxBytes || afterRead.size !== metadata.size || afterRead.mtimeMs !== metadata.mtimeMs ||
        afterRead.ctimeMs !== metadata.ctimeMs) throw new Error();
    if (exactTextRequired) validateExactText(bytes.subarray(0, length));
    const snapshot = join(executionRoot, leaf);
    writeFileSync(snapshot, bytes.subarray(0, length), { mode: 0o600, flag: "wx" });
    return snapshot;
  } catch (error) {
    if (error instanceof CitationInputError) {
      throw new Error("Citation input must be 1–65536 bytes of UTF-8 without a BOM or NUL");
    }
    throw new Error(`${inputLabel} could not be fixed safely for execution`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateExactText(bytes) {
  if (bytes.length === 0 || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) || bytes.includes(0)) {
    throw new CitationInputError();
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CitationInputError();
  }
}

export function directoryIdentity(path, label) {
  try {
    const resolved = realpathSync(path);
    const metadata = lstatSync(resolved);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error();
    return { resolved, dev: metadata.dev, ino: metadata.ino };
  } catch {
    throw new Error(`${label} must be an existing real directory`);
  }
}

export function assertDirectoryIdentity(path, expected, label, operation = "onboarding") {
  const current = directoryIdentity(path, label);
  if (current.resolved !== expected.resolved || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`${label} identity changed during ${operation}`);
  }
}

export function assertFileIdentity(path, expected, label) {
  try {
    const current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino ||
        current.size !== expected.size || current.mtimeMs !== expected.mtimeMs || current.ctimeMs !== expected.ctimeMs) throw new Error();
  } catch {
    throw new Error(`${label} identity changed during verification`);
  }
}

export async function runChecked(command, executable, arguments_, options, label) {
  const result = await command(executable, arguments_, options);
  if (result.spawnError) throw new Error(`${label} could not start`);
  if (result.timedOut) throw new Error(`${label} timed out`);
  if (result.stdoutExceeded || result.stderrExceeded) throw new Error(`${label} output exceeded its safety limit`);
  if (result.code !== 0) throw new Error(classifyFailure(label, result));
  return result;
}

function classifyFailure(label, result) {
  const details = String(result.stderr).toLowerCase();
  const diagnosticCode = parseChildDiagnosticCode(result.stderr);
  if (label === "Evidence Forge retained packet verification" && diagnosticCode === "EVIDENCE_PACKET_HEAD_MISMATCH") {
    return "Evidence packet does not match --expected-sha256; check the independently kept digest or restore the packet";
  }
  if (label === "Evidence Forge retained packet verification" && diagnosticCode === "EVIDENCE_PACKET_INVALID") {
    return "Evidence packet is invalid or inconsistent; restore it from a trusted copy";
  }
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

function parseChildDiagnosticCode(source) {
  let report;
  try { report = JSON.parse(String(source)); } catch { return undefined; }
  return hasExactKeys(report, ["version", "kind", "outcome", "code", "message"]) && report.version === 1 &&
    report.kind === "EvidenceForgeCliError" && report.outcome === "error" && /^[A-Z][A-Z0-9_]{2,63}$/u.test(report.code ?? "")
    ? report.code
    : undefined;
}

export function hasExactKeys(value, keys) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export async function executeCommand(command, arguments_, { cwd, environment, timeoutMs } = {}) {
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
