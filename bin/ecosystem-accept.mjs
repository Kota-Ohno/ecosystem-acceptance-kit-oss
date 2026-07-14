#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatDemo, runOfflineDemo } from "../lib/demo.mjs";
import { bootstrapWorkspace, formatBootstrap, textBootstrapReporter } from "../lib/bootstrap.mjs";
import { diagnoseEnvironment, formatDoctor } from "../lib/doctor.mjs";
import { appendIndex, verifyIndexFile } from "../lib/index.mjs";
import { loadManifest } from "../lib/manifest.mjs";
import { formatOnboard, onboardFirstEvidence } from "../lib/onboard.mjs";
import { compareManifests } from "../lib/preflight.mjs";
import { loadAndVerifyReceipt } from "../lib/receipt.mjs";
import { createPlan, runAcceptance } from "../lib/runner.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = `Usage:
  ecosystem-accept demo [--json]
  ecosystem-accept doctor [--offline] [--json]
  ecosystem-accept bootstrap [--manifest FILE] [--workspace-root DIR] [--json]
  ecosystem-accept onboard [--manifest FILE] [--workspace-root DIR] [--directory NEW_DIR] [--source FILE --exact TEXT --available-at ISO --promote-immediately] [--json]
  ecosystem-accept run [--manifest FILE] [--output-root DIR] [--workspace-root DIR] [--keep-workspace]
  ecosystem-accept plan [--manifest FILE]
  ecosystem-accept compare OLD_LOCK NEW_LOCK [--output FILE]
  ecosystem-accept index append --receipt FILE --expected-receipt-sha256 SHA256 --output NEW_FILE [--previous-index FILE --expected-index-sha256 SHA256]
  ecosystem-accept index verify --index FILE --expected-index-sha256 SHA256
  ecosystem-accept verify-receipt FILE`;

function parse(arguments_) {
  if (arguments_.includes("--help") || arguments_.includes("-h")) return { command: "help" };
  const command = arguments_[0];
  if (!["demo", "doctor", "bootstrap", "onboard", "run", "plan", "compare", "index", "verify-receipt"].includes(command)) throw new Error(usage);
  if (command === "demo") {
    if (arguments_.some((value, index) => index > 0 && value !== "--json")) throw new Error(usage);
    return { command, json: arguments_.includes("--json") };
  }
  if (command === "doctor") {
    if (arguments_.some((value, index) => index > 0 && !["--offline", "--json"].includes(value))) throw new Error(usage);
    return { command, network: !arguments_.includes("--offline"), json: arguments_.includes("--json") };
  }
  if (command === "bootstrap") return parseBootstrap(arguments_.slice(1));
  if (command === "onboard") return parseOnboard(arguments_.slice(1));
  if (command === "index") return parseIndex(arguments_.slice(1));
  if (command === "compare") {
    if (arguments_.length < 3 || arguments_.length > 5) throw new Error(usage);
    const options = { command, oldManifest: resolve(arguments_[1]), newManifest: resolve(arguments_[2]) };
    if (arguments_.length > 3) {
      if (arguments_[3] !== "--output" || !arguments_[4] || arguments_[4].startsWith("--")) throw new Error(usage);
      options.output = resolve(arguments_[4]);
    }
    return options;
  }
  if (command === "verify-receipt") {
    if (arguments_.length !== 2 || arguments_[1].startsWith("--")) throw new Error(usage);
    return { command, receipt: resolve(arguments_[1]) };
  }
  const options = { command, manifest: resolve(root, "acceptance.lock.json"), outputRoot: resolve(root, ".acceptance-output"), workspaceRoot: resolve(root, ".acceptance-workspace"), keepWorkspace: false };
  for (let index = 1; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (name === "--keep-workspace" && command === "run") { options.keepWorkspace = true; continue; }
    const value = arguments_[index + 1];
    if (!["--manifest", "--output-root", "--workspace-root"].includes(name) || !value || value.startsWith("--")) throw new Error(usage);
    if (command === "plan" && name !== "--manifest") throw new Error(usage);
    const key = { "--manifest": "manifest", "--output-root": "outputRoot", "--workspace-root": "workspaceRoot" }[name];
    options[key] = resolve(value);
    index += 1;
  }
  return options;
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.command === "help") { process.stdout.write(`${usage}\n`); return; }
  if (options.command === "demo") {
    const report = runOfflineDemo();
    process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : formatDemo(report)}\n`);
    return;
  }
  if (options.command === "doctor") {
    const { manifest } = loadManifest(resolve(root, "acceptance.lock.json"));
    const report = await diagnoseEnvironment({ manifest, network: options.network });
    process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : formatDoctor(report)}\n`);
    if (report.outcome === "not_ready") process.exitCode = 2;
    return;
  }
  if (options.command === "bootstrap") {
    const { manifest } = loadManifest(options.manifest);
    const report = await bootstrapWorkspace({
      manifest,
      workspaceRoot: options.workspaceRoot,
      reporter: textBootstrapReporter((line) => process.stderr.write(line)),
    });
    process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : formatBootstrap(report)}\n`);
    return;
  }
  if (options.command === "onboard") {
    const { manifest } = loadManifest(options.manifest);
    const report = await onboardFirstEvidence({
      manifest,
      workspaceRoot: options.workspaceRoot,
      directory: options.directory,
      source: options.source,
      exact: options.exact,
      availableAt: options.availableAt,
      promoteImmediately: options.promoteImmediately,
      reporter: textBootstrapReporter((line) => process.stderr.write(line)),
    });
    process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : formatOnboard(report)}\n`);
    return;
  }
  if (options.command === "verify-receipt") {
    process.stdout.write(`${JSON.stringify(loadAndVerifyReceipt(options.receipt), null, 2)}\n`);
    return;
  }
  if (options.command === "index-append") {
    const index = appendIndex(options);
    process.stdout.write(`${JSON.stringify({ outcome: "appended", entries: index.entries.length, indexSha256: index.integrity.indexSha256 }, null, 2)}\n`);
    return;
  }
  if (options.command === "index-verify") {
    process.stdout.write(`${JSON.stringify(verifyIndexFile(options.index, options.expectedIndexSha256), null, 2)}\n`);
    return;
  }
  if (options.command === "compare") {
    const oldManifest = loadManifest(options.oldManifest).manifest;
    const newManifest = loadManifest(options.newManifest).manifest;
    const report = await compareManifests({ oldManifest, newManifest, output: options.output });
    if (!options.output) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`Preflight report: ${options.output}\nIntegrity: ${report.integrity.receiptSha256}\n`);
    return;
  }
  const { manifest } = loadManifest(options.manifest);
  if (options.command === "plan") { process.stdout.write(`${JSON.stringify(createPlan(manifest), null, 2)}\n`); return; }
  mkdirSync(options.outputRoot, { recursive: true, mode: 0o700 });
  mkdirSync(options.workspaceRoot, { recursive: true, mode: 0o700 });
  await runAcceptance({ ...options, manifest, root });
}

function parseBootstrap(arguments_) {
  const options = {
    command: "bootstrap",
    manifest: resolve(root, "acceptance.lock.json"),
    workspaceRoot: resolve(process.cwd(), "evidence-ecosystem-workspace"),
    json: false,
  };
  const seen = new Set();
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (seen.has(name)) throw new Error(usage);
    seen.add(name);
    if (name === "--json") { options.json = true; continue; }
    const value = arguments_[index + 1];
    if (!["--manifest", "--workspace-root"].includes(name) || !value || value.startsWith("--")) throw new Error(usage);
    options[name === "--manifest" ? "manifest" : "workspaceRoot"] = resolve(value);
    index += 1;
  }
  return options;
}

function parseOnboard(arguments_) {
  const options = {
    command: "onboard",
    manifest: resolve(root, "acceptance.lock.json"),
    workspaceRoot: resolve(process.cwd(), "evidence-ecosystem-workspace"),
    directory: resolve(process.cwd(), "my-first-evidence"),
    promoteImmediately: false,
    json: false,
  };
  const seen = new Set();
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    if (seen.has(name)) throw new Error(usage);
    seen.add(name);
    if (name === "--json") { options.json = true; continue; }
    if (name === "--promote-immediately") { options.promoteImmediately = true; continue; }
    const value = arguments_[index + 1];
    if (!["--manifest", "--workspace-root", "--directory", "--source", "--exact", "--available-at"].includes(name) ||
        !value || (name !== "--exact" && value.startsWith("--"))) throw new Error(usage);
    const key = {
      "--manifest": "manifest", "--workspace-root": "workspaceRoot", "--directory": "directory",
      "--source": "source", "--exact": "exact", "--available-at": "availableAt",
    }[name];
    options[key] = ["--manifest", "--workspace-root", "--directory", "--source"].includes(name) ? resolve(value) : value;
    index += 1;
  }
  const localCount = [options.source, options.exact, options.availableAt, options.promoteImmediately].filter((value) => value !== undefined && value !== false).length;
  if (localCount !== 0 && localCount !== 4) {
    const missing = [
      ["--source", options.source], ["--exact", options.exact], ["--available-at", options.availableAt],
      ["--promote-immediately", options.promoteImmediately],
    ].filter(([, value]) => value === undefined || value === false).map(([name]) => name);
    throw new Error(`Local-file onboarding is missing required options: ${missing.join(", ")}`);
  }
  return options;
}

function parseIndex(arguments_) {
  const subcommand = arguments_[0];
  const values = new Map();
  for (let index = 1; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || values.has(name)) throw new Error(usage);
    values.set(name, value);
  }
  const required = subcommand === "append" ? ["--receipt", "--expected-receipt-sha256", "--output"] : subcommand === "verify" ? ["--index", "--expected-index-sha256"] : [];
  const allowed = subcommand === "append" ? [...required, "--previous-index", "--expected-index-sha256"] : required;
  if (!required.length || required.some((name) => !values.has(name)) || [...values.keys()].some((name) => !allowed.includes(name))) throw new Error(usage);
  if (subcommand === "append" && (values.has("--previous-index") !== values.has("--expected-index-sha256"))) throw new Error(usage);
  if (subcommand === "append") return {
    command: "index-append",
    receipt: resolve(values.get("--receipt")),
    expectedReceiptSha256: values.get("--expected-receipt-sha256"),
    output: resolve(values.get("--output")),
    ...(values.has("--previous-index") ? { previousIndex: resolve(values.get("--previous-index")), expectedIndexSha256: values.get("--expected-index-sha256") } : {}),
  };
  return { command: "index-verify", index: resolve(values.get("--index")), expectedIndexSha256: values.get("--expected-index-sha256") };
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
