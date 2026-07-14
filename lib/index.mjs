import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { digest, verifyReceipt } from "./receipt.mjs";

const SHA256 = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const ARTIFACT_NAME = /^[a-z][A-Za-z0-9]{0,63}$/u;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 1024;

export function appendIndex({ receipt, expectedReceiptSha256, output, previousIndex, expectedIndexSha256 }) {
  requireSha(expectedReceiptSha256, "Expected receipt SHA-256");
  const receiptValue = readBoundedJson(receipt, "Acceptance receipt");
  const verifiedReceipt = verifyReceipt(receiptValue);
  if (verifiedReceipt.receiptSha256 !== expectedReceiptSha256) throw new Error("Acceptance receipt does not match the independently supplied head");
  if (receiptValue.outcome !== "verified") throw new Error("Only verified acceptance receipts can be retained");
  if (receiptValue.assurance?.exactRevisionsChecked !== true || receiptValue.assurance?.productChecksPassed !== true ||
      receiptValue.assurance?.packedAcceptancePassed !== true || receiptValue.assurance?.ephemeralPrivateKeysRetained !== false) {
    throw new Error("Acceptance receipt does not satisfy the retained-index assurance contract");
  }
  const previous = previousIndex ? readBoundedJson(previousIndex, "Acceptance index") : emptyIndex();
  if (previousIndex) verifyIndex(previous, expectedIndexSha256);
  else if (expectedIndexSha256) throw new Error("An expected index head requires a previous index");
  if (previous.entries.length >= MAX_ENTRIES) throw new Error(`Acceptance index cannot exceed ${MAX_ENTRIES} entries`);
  if (previous.entries.some((entry) => entry.receiptSha256 === expectedReceiptSha256)) throw new Error("Acceptance receipt is already indexed");
  if (previous.entries.some((entry) => entry.runId === receiptValue.runId)) throw new Error("Acceptance runId is already indexed");

  const artifacts = receiptValue.artifacts;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) throw new Error("Acceptance receipt artifacts are invalid");
  exactKeys(artifacts, ["releasePack", "stackReport", "verificationReceipt"], "Acceptance receipt artifacts");
  const artifactSha256s = {};
  for (const [name, artifact] of Object.entries(artifacts)) {
    if (!ARTIFACT_NAME.test(name)) throw new Error("Artifact name is invalid");
    requireSha(artifact?.sha256, `Artifact ${name} SHA-256`);
    artifactSha256s[name] = artifact.sha256;
  }
  const entryBody = {
    sequence: previous.entries.length + 1,
    receiptSha256: expectedReceiptSha256,
    previousEntrySha256: previous.entries.at(-1)?.entrySha256 ?? null,
    runId: string(receiptValue.runId, "Acceptance receipt runId"),
    completedAt: isoDate(receiptValue.completedAt, "Acceptance receipt completedAt"),
    revisions: revisions(receiptValue.revisions),
    artifactSha256s,
  };
  const entry = { ...entryBody, entrySha256: digest(entryBody) };
  const body = {
    version: 1,
    entries: [...previous.entries, entry],
    anchorPolicy: { expectedReceiptSha256Required: true, independentChannelAttested: false, timestampAttested: false },
  };
  const index = { ...body, integrity: { algorithm: "sha256-jcs", indexSha256: digest(body) } };
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(output, 0o600);
  return index;
}

export function verifyIndexFile(path, expectedIndexSha256) {
  const index = readBoundedJson(path, "Acceptance index");
  verifyIndex(index, expectedIndexSha256);
  return { outcome: "verified", entries: index.entries.length, latestReceiptSha256: index.entries.at(-1)?.receiptSha256 ?? null, indexSha256: index.integrity.indexSha256, timestampAttested: false };
}

export function verifyIndex(index, expectedIndexSha256) {
  requireSha(expectedIndexSha256, "Expected index SHA-256");
  if (!index || typeof index !== "object" || Array.isArray(index) || index.version !== 1) throw new Error("Acceptance index is invalid");
  exactKeys(index, ["anchorPolicy", "entries", "integrity", "version"], "Acceptance index");
  if (!Array.isArray(index.entries) || index.entries.length < 1 || index.entries.length > MAX_ENTRIES) throw new Error("Acceptance index entries are invalid");
  const { integrity, ...body } = index;
  exactKeys(integrity, ["algorithm", "indexSha256"], "Acceptance index integrity");
  if (integrity?.algorithm !== "sha256-jcs" || integrity.indexSha256 !== expectedIndexSha256 || digest(body) !== expectedIndexSha256) throw new Error("Acceptance index integrity verification failed");
  if (JSON.stringify(index.anchorPolicy) !== JSON.stringify({ expectedReceiptSha256Required: true, independentChannelAttested: false, timestampAttested: false })) throw new Error("Acceptance index anchor policy is invalid");
  const seen = new Set();
  const seenRuns = new Set();
  let previous = null;
  for (let position = 0; position < index.entries.length; position += 1) {
    const entry = index.entries[position];
    exactKeys(entry, ["artifactSha256s", "completedAt", "entrySha256", "previousEntrySha256", "receiptSha256", "revisions", "runId", "sequence"], "Acceptance index entry");
    const { entrySha256, ...entryBody } = entry;
    requireSha(entrySha256, "Acceptance index entry SHA-256");
    requireSha(entry.receiptSha256, "Acceptance index receipt SHA-256");
    if (entry.sequence !== position + 1 || entry.previousEntrySha256 !== previous || digest(entryBody) !== entrySha256 || seen.has(entry.receiptSha256)) throw new Error("Acceptance index entry chain verification failed");
    revisions(entry.revisions);
    if (!entry.artifactSha256s || typeof entry.artifactSha256s !== "object" || Array.isArray(entry.artifactSha256s)) throw new Error("Acceptance index artifacts are invalid");
    exactKeys(entry.artifactSha256s, ["releasePack", "stackReport", "verificationReceipt"], "Acceptance index artifacts");
    for (const [name, sha256] of Object.entries(entry.artifactSha256s)) {
      if (!ARTIFACT_NAME.test(name)) throw new Error("Artifact name is invalid");
      requireSha(sha256, `Artifact ${name} SHA-256`);
    }
    string(entry.runId, "Acceptance index runId");
    if (seenRuns.has(entry.runId)) throw new Error("Acceptance index contains a duplicate runId");
    isoDate(entry.completedAt, "Acceptance index completedAt");
    seen.add(entry.receiptSha256);
    seenRuns.add(entry.runId);
    previous = entrySha256;
  }
  return true;
}

function emptyIndex() { return { version: 1, entries: [], anchorPolicy: { expectedReceiptSha256Required: true, independentChannelAttested: false, timestampAttested: false } }; }

function readBoundedJson(path, label) {
  const size = statSync(path).size;
  if (size < 2 || size > MAX_INDEX_BYTES) throw new Error(`${label} exceeds the supported size`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function revisions(value) {
  const names = ["agentBlackBox", "evidenceForge", "solLedger", "solLedgerContract"];
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...names].sort())) throw new Error("Acceptance revisions are invalid");
  return Object.fromEntries(names.map((name) => { if (!REVISION.test(value[name] ?? "")) throw new Error(`${name} revision is invalid`); return [name, value[name]]; }));
}

function requireSha(value, label) { if (!SHA256.test(value ?? "")) throw new Error(`${label} is invalid`); }
function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) throw new Error(`${label} fields are invalid`);
}
function string(value, label) { if (typeof value !== "string" || value.length < 1 || value.length > 256) throw new Error(`${label} is invalid`); return value; }
function isoDate(value, label) { if (typeof value !== "string" || new Date(value).toISOString() !== value) throw new Error(`${label} is invalid`); return value; }
