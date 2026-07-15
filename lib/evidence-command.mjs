import { createInterface } from "node:readline/promises";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalFuturePath } from "./bootstrap.mjs";
import { registerProcessExitCleanup } from "./child-process.mjs";
import { pathsOverlap } from "./evidence-runtime.mjs";
import { formatOnboard, snapshotInput } from "./onboard.mjs";
import { isRfc3339 } from "./rfc3339.mjs";

export const evidenceUsage = `Usage:
  ecosystem-accept evidence SOURCE [--available-at ISO] [--directory NEW_DIR] [--workspace-root DIR]
  ecosystem-accept evidence SOURCE --yes --available-at ISO [--directory NEW_DIR]
                                      [--workspace-root DIR] [--json]

Without --yes, an interactive terminal confirms the whole-file citation,
observation time, and immediate promotion before any Evidence is created.
For automation, --yes accepts the whole-file citation, immediate promotion,
and possible network access plus execution of the Kit's included pinned code.
--available-at is always required with --yes.`;

export function parseEvidenceArguments(arguments_, {
  cwd = process.cwd(), defaultManifest, createDirectory, now = () => new Date(),
} = {}) {
  if (typeof defaultManifest !== "string" || typeof createDirectory !== "function") {
    throw new TypeError("defaultManifest and createDirectory are required");
  }
  const options = {
    command: "evidence",
    manifest: resolve(defaultManifest),
    workspaceRoot: resolve(cwd, "evidence-ecosystem-workspace"),
    yes: false,
    json: false,
  };
  const seen = new Set();
  let source;
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (!name.startsWith("--")) {
      if (source !== undefined) throw new Error(evidenceUsage);
      source = resolve(cwd, name);
      continue;
    }
    if (seen.has(name)) throw new Error(evidenceUsage);
    seen.add(name);
    if (name === "--yes") { options.yes = true; continue; }
    if (name === "--json") { options.json = true; continue; }
    const value = arguments_[index + 1];
    if (!["--workspace-root", "--directory", "--available-at"].includes(name) ||
        !value || value.startsWith("--")) throw new Error(evidenceUsage);
    const key = {
      "--workspace-root": "workspaceRoot",
      "--directory": "directory", "--available-at": "availableAt",
    }[name];
    options[key] = name === "--available-at" ? value : resolve(cwd, value);
    index += 1;
  }
  if (!source) throw new Error(`A source file is required.\n\n${evidenceUsage}`);
  if (options.json && !options.yes) {
    throw new Error("--json requires --yes so machine output never waits for interactive input");
  }
  if (options.yes && !options.availableAt) {
    throw new Error("--yes requires --available-at because the Kit does not silently invent observation time");
  }
  if (options.availableAt && !isRfc3339(options.availableAt)) {
    throw new Error("--available-at must be an RFC 3339 timestamp such as 2026-07-11T00:00:00Z");
  }
  if (options.availableAt && Date.parse(options.availableAt) > now().getTime()) {
    throw new Error("--available-at cannot be in the future; use the time the source was actually available to you");
  }
  return {
    ...options,
    source,
    directory: options.directory ?? createDirectory(cwd),
  };
}

export async function confirmEvidenceIntent(options, {
  input = process.stdin, output = process.stderr, now = () => new Date(), createPrompt,
} = {}) {
  if (options.yes) return { availableAt: options.availableAt };
  if (input.isTTY !== true || output.isTTY !== true) {
    throw new Error("Interactive evidence setup requires a terminal. For automation, pass --yes and --available-at <RFC3339>.");
  }
  const prompt = createPrompt ? createPrompt({ input, output }) : createInterface({ input, output });
  try {
    output.write([
      "Create verifiable Evidence from one local file",
      "  A private snapshot, whole-file citation, and verification packet will be created.",
      "  The Kit may contact GitHub and the package registry, then runs its included pinned Evidence Forge code",
      "  with your user permissions. Dependency lifecycle scripts stay disabled.",
      "  The reviewed pinned workflow is designed not to upload the source; this is not enforced by a sandbox.",
      "  See docs/THREAT_MODEL.md before using highly sensitive material.",
      ...(options.sourceSha256 ? [`  Fixed source fingerprint: ${options.sourceSha256}`] : []),
      "  This checks integrity; it does not prove that the source is true or independently timestamped.",
      "",
    ].join("\n"));
    const wholeFile = await prompt.question("Use the entire fixed file snapshot as the cited observation? [y/N] ");
    if (!isYes(wholeFile)) {
      throw new Error("Cancelled before creating Evidence. Use the advanced onboard command to cite only an excerpt.");
    }
    let availableAt = options.availableAt;
    if (availableAt) {
      output.write(`Observation time from --available-at: ${availableAt}\n`);
    } else {
      while (!availableAt) {
        const answer = await prompt.question("When was this source available to you? Enter RFC 3339, or 'now' if it became available just now: ");
        const currentTime = now();
        const candidate = /^now$/iu.test(answer.trim()) ? currentTime.toISOString() : answer.trim();
        if (!isRfc3339(candidate)) {
          output.write("  Invalid time. Use RFC 3339 such as 2026-07-11T00:00:00Z, or enter 'now'.\n");
          continue;
        }
        if (Date.parse(candidate) > currentTime.getTime()) {
          output.write("  Observation time cannot be in the future. Try again.\n");
          continue;
        }
        availableAt = candidate;
      }
    }
    const promotion = await prompt.question("Run the included pinned code and create Verified Evidence now? Choose no to exit. [y/N] ");
    if (!isYes(promotion)) {
      throw new Error("Cancelled before creating Evidence. Use capture then promote when Candidate inspection is required.");
    }
    return { availableAt };
  } finally {
    prompt.close();
  }
}

export function evidenceProgressReporter(write, { onEvidenceCreated = () => {} } = {}) {
  const labels = {
    "offline-demo": "Check the local verifier",
    "environment-doctor": "Check required tools",
    "checkout:evidenceForge": "Prepare the pinned Evidence engine",
    "evidence-forge:fresh-execution-checkout": "Create a clean execution copy",
    "evidence-forge:dependencies": "Install pinned dependencies (lifecycle scripts disabled)",
    "evidence-forge:local-file": "Record and verify the selected file",
    "evidence-forge:verify-packet": "Re-check the portable packet",
    "evidence-forge:verify-checkout": "Confirm the engine stayed unchanged",
  };
  return ({ state, position, total, name, durationMs }) => {
    if (state === "done" && name === "evidence-forge:local-file") onEvidenceCreated();
    const status = state === "start" ? "START" : state === "done" ? "DONE " : "FAIL ";
    const marker = state === "start" ? "▶" : state === "done" ? "✓" : "✗";
    const duration = state === "start" ? "" : ` (${(durationMs / 1000).toFixed(1)}s)`;
    write(`[${String(position).padStart(2, "0")}/${String(total).padStart(2, "0")}] ${status} ${marker} ${labels[name] ?? name}${duration}\n`);
  };
}

export function formatEvidenceSummary(report) {
  const evidence = report.evidence;
  const technical = formatOnboard(report);
  const verificationCommand = technical.split("\n").find((line) => line.trimStart().startsWith("pnpm --dir"))?.trim();
  return [
    "Evidence created and verified",
    "",
    "What happened",
    "  ✓ The selected local file was captured as a private, integrity-bound snapshot.",
    "  ✓ The whole file was cited and promoted to Verified Evidence with your prior approval.",
    "  ✓ A portable packet was separately re-checked by the pinned verifier against its SHA-256 fingerprint.",
    "",
    "What was recorded",
    `  Evidence directory: ${safeDisplay(report.directory)}`,
    `  Packet file: ${safeDisplay(evidence.artifacts.packet)}`,
    `  Verification fingerprint: ${evidence.packetSha256}`,
    "  The Kit did not print the source content. The timestamp is operator-supplied, not independently attested.",
    "",
    "What to do next",
    "  1. Keep the Evidence directory private.",
    "  2. Store the verification fingerprint somewhere separate from that directory.",
    ...(verificationCommand ? ["  3. Re-check it later with:", `     ${verificationCommand}`] : [
      "  3. Re-check it later with pnpm verify-evidence and the separately stored fingerprint.",
    ]),
  ].join("\n");
}

export function formatEvidenceStart(directory) {
  return `Evidence output (new private directory): ${safeDisplay(directory)}`;
}

export function formatEvidenceFailure(directory) {
  return [
    "Partial Evidence output was retained but is not a verified result.",
    `  Location: ${safeDisplay(directory)}`,
    "  Inspect or remove it manually. A retry must use a different new directory.",
  ].join("\n");
}

export function prepareEvidenceSource({ source, workspaceRoot, directory } = {}) {
  if (!source || !workspaceRoot || !directory) throw new TypeError("source, workspaceRoot, and directory are required");
  if (existsSync(directory)) throw new Error("Evidence output directory already exists; choose a new directory");
  let metadata;
  let sourceBoundary;
  try {
    metadata = lstatSync(source);
    sourceBoundary = realpathSync(source);
  } catch {
    throw new Error("Selected source is unavailable; choose an existing local file");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Selected source must be a regular non-symbolic-link file");
  }
  if (pathsOverlap(canonicalFuturePath(workspaceRoot), sourceBoundary) ||
      pathsOverlap(canonicalFuturePath(directory), sourceBoundary)) {
    throw new Error("Selected source must be outside the Evidence workspace and output directory");
  }
  const temporaryRoot = mkdtempSync(join(tmpdir(), "ecosystem-evidence-source-"));
  let removed = false;
  const remove = () => {
    if (!removed) {
      rmSync(temporaryRoot, { recursive: true, force: true });
      removed = true;
    }
  };
  const unregister = registerProcessExitCleanup(remove);
  try {
    const path = snapshotInput(
      source, temporaryRoot, "fixed-source.txt", 64 * 1024, false,
      { dev: metadata.dev, ino: metadata.ino }, true, "Selected source",
    );
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    return { path, sha256, cleanup: () => { remove(); unregister(); } };
  } catch (error) {
    remove();
    unregister();
    if (error instanceof Error && /Citation input must/u.test(error.message)) {
      throw new Error("Selected source must be non-empty UTF-8, at most 64 KiB, without a BOM or NUL");
    }
    throw error;
  }
}

function isYes(value) {
  return /^(?:y|yes)$/iu.test(value.trim());
}

function safeDisplay(value) {
  if (typeof value !== "string") return "[invalid]";
  return [...value].map((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c || (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x2028 && codePoint <= 0x202e) || (codePoint >= 0x2060 && codePoint <= 0x206f) ||
      codePoint === 0xfeff
      ? `\\u${codePoint.toString(16).padStart(codePoint <= 0xffff ? 4 : 8, "0")}`
      : character;
  }).join("");
}
