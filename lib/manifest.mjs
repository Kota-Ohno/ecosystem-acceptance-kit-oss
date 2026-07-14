import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPOSITORY_NAMES = ["agentBlackBox", "solLedger", "evidenceForge"];
const REVISION = /^[0-9a-f]{40}$/u;

export function loadManifest(path) {
  const manifestPath = resolve(path);
  const value = JSON.parse(readFileSync(manifestPath, "utf8"));
  return { manifest: validateManifest(value), manifestPath };
}

export function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("must be an object");
  const topLevelKeys = Object.keys(value).sort();
  if (JSON.stringify(topLevelKeys) !== JSON.stringify(["protocolContractRevision", "repositories", "version"])) {
    invalid("must contain exactly version, protocolContractRevision, and repositories");
  }
  if (value.version !== 1) invalid("version must be 1");
  if (!REVISION.test(value.protocolContractRevision)) invalid("protocolContractRevision must be a full lowercase commit SHA");
  const repositories = value.repositories;
  if (!repositories || typeof repositories !== "object" || Array.isArray(repositories)) {
    invalid("repositories must be an object");
  }
  const keys = Object.keys(repositories).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...REPOSITORY_NAMES].sort())) {
    invalid(`repositories must contain exactly ${REPOSITORY_NAMES.join(", ")}`);
  }
  const normalized = {};
  for (const name of REPOSITORY_NAMES) {
    const entry = repositories[name];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid(`${name} must be an object`);
    const entryKeys = Object.keys(entry).sort();
    if (JSON.stringify(entryKeys) !== JSON.stringify(["revision", "url"])) {
      invalid(`${name} must contain exactly url and revision`);
    }
    let url;
    try { url = new URL(entry.url); } catch { invalid(`${name}.url must be a valid URL`); }
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash) {
      invalid(`${name}.url must be an uncredentialed github.com HTTPS URL`);
    }
    if (!REVISION.test(entry.revision)) invalid(`${name}.revision must be a full lowercase commit SHA`);
    normalized[name] = { url: url.href, revision: entry.revision };
  }
  return { version: 1, protocolContractRevision: value.protocolContractRevision, repositories: normalized };
}

function invalid(message) {
  throw new Error(`Invalid acceptance manifest: ${message}`);
}

export const repositoryNames = Object.freeze([...REPOSITORY_NAMES]);
