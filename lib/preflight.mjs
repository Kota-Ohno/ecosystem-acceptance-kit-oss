import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repositoryNames } from "./manifest.mjs";
import { digest, sealReceipt, writeReceipt } from "./receipt.mjs";

const MAX_CHANGED_PATHS = 200;

export async function compareManifests({ oldManifest, newManifest, output }) {
  const workspace = mkdtempSync(join(tmpdir(), "ecosystem-preflight-"));
  const repositories = {};
  let networkUsed = false;
  try {
    for (const name of repositoryNames) {
      const older = oldManifest.repositories[name];
      const newer = newManifest.repositories[name];
      if (older.url !== newer.url) {
        repositories[name] = relocatedSummary(older, newer);
        continue;
      }
      if (older.revision === newer.revision) {
        repositories[name] = unchangedSummary(older);
        continue;
      }
      networkUsed = true;
      const paths = await changedPaths({ url: older.url, older: older.revision, newer: newer.revision, workspace: join(workspace, name) });
      repositories[name] = changedSummary(name, older, newer, paths);
    }

    const contractChanged = oldManifest.protocolContractRevision !== newManifest.protocolContractRevision;
    let contractPaths = [];
    let contractRelocated = false;
    if (contractChanged) {
      const olderUrl = oldManifest.repositories.solLedger.url;
      const newerUrl = newManifest.repositories.solLedger.url;
      if (olderUrl === newerUrl) {
        networkUsed = true;
        contractPaths = await changedPaths({
          url: olderUrl,
          older: oldManifest.protocolContractRevision,
          newer: newManifest.protocolContractRevision,
          workspace: join(workspace, "contract"),
        });
      } else contractRelocated = true;
    }
    const contractSchemaPaths = contractPaths.filter(isSchemaPath);
    const anyRepositoryChange = Object.values(repositories).some((entry) => entry.changed);
    const schemaChanged = contractSchemaPaths.length > 0 || Object.values(repositories).some((entry) => entry.categories.schema > 0);
    const manualReviewRequired = contractChanged || schemaChanged || contractRelocated || Object.values(repositories).some((entry) => entry.relocated);
    const body = {
      version: 1,
      outcome: "analyzed",
      comparedAt: new Date().toISOString(),
      manifests: { olderSha256: digest(oldManifest), newerSha256: digest(newManifest) },
      repositories,
      protocolContract: {
        changed: contractChanged,
        relocated: contractRelocated,
        olderRevision: oldManifest.protocolContractRevision,
        newerRevision: newManifest.protocolContractRevision,
        changedPathCount: contractPaths.length,
        schemaChanged: contractSchemaPaths.length > 0,
        schemaPaths: bounded(contractSchemaPaths),
        schemaPathsTruncated: contractSchemaPaths.length > MAX_CHANGED_PATHS,
      },
      decision: {
        changeClass: !anyRepositoryChange && !contractChanged ? "none" : manualReviewRequired ? "contract-review" : "implementation",
        fullAcceptanceRequired: anyRepositoryChange || contractChanged,
        manualReviewRequired,
      },
      assurance: {
        repositoryCodeExecuted: false,
        exactCommitsCompared: !Object.values(repositories).some((entry) => entry.relocated) && !contractRelocated,
        semanticCompatibilityProven: false,
        networkUsed,
        timestampAttested: false,
      },
    };
    if (output) {
      mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
      return writeReceipt(output, body);
    }
    return sealReceipt(body);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}

export function classifyPaths(name, paths) {
  return {
    product: name === "solLedger" ? 0 : paths.length,
    protocol: name === "solLedger" ? paths.length : 0,
    schema: paths.filter(isSchemaPath).length,
    acceptance: paths.filter(isAcceptancePath).length,
  };
}

function changedSummary(name, older, newer, paths) {
  return {
    changed: true,
    relocated: false,
    olderRevision: older.revision,
    newerRevision: newer.revision,
    changedPathCount: paths.length,
    categories: classifyPaths(name, paths),
    paths: bounded(paths),
    pathsTruncated: paths.length > MAX_CHANGED_PATHS,
  };
}

function unchangedSummary(entry) {
  return { changed: false, relocated: false, olderRevision: entry.revision, newerRevision: entry.revision, changedPathCount: 0, categories: classifyPaths("", []), paths: [], pathsTruncated: false };
}

function relocatedSummary(older, newer) {
  return { changed: true, relocated: true, olderRevision: older.revision, newerRevision: newer.revision, changedPathCount: null, categories: { product: null, protocol: null, schema: null, acceptance: null }, paths: [], pathsTruncated: false };
}

async function changedPaths({ url, older, newer, workspace }) {
  mkdirSync(workspace, { mode: 0o700 });
  await command("git", ["init", "--quiet"], workspace);
  await command("git", ["remote", "add", "origin", url], workspace);
  await command("git", ["fetch", "--quiet", "--depth=1", "origin", older, newer], workspace);
  const output = await capture("git", ["diff", "--name-only", "-z", older, newer, "--"], workspace);
  return output.split("\0").filter(Boolean).sort();
}

function isSchemaPath(path) {
  return /(^|\/)(schemas?|generated-types?)(\/|\.|$)/iu.test(path) || /packages\/typescript\/src\/generated/iu.test(path);
}

function isAcceptancePath(path) {
  return /(acceptance|compatib|interop|dogfood|fixture)/iu.test(path);
}

function bounded(paths) { return paths.slice(0, MAX_CHANGED_PATHS); }

async function command(executable, arguments_, cwd) { await capture(executable, arguments_, cwd); }

async function capture(executable, arguments_, cwd) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); if (stdout.length > 8 * 1024 * 1024) child.kill(); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); if (stderr.length > 1024 * 1024) child.kill(); });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolvePromise(stdout) : reject(new Error(`${executable} preflight failed with ${code ?? signal}: ${stderr.slice(-1000)}`)));
  });
}
