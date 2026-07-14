import { tmpdir } from "node:os";
import { runChildProcess } from "./child-process.mjs";

export const REQUIRED_NODE_VERSION = "24.4.0";

const TOOL_SPECS = [
  { name: "git", arguments: ["--version"] },
  { name: "npm", arguments: ["--version"] },
  { name: "pnpm", arguments: ["--version"] },
  { name: "cargo", arguments: ["--version"] },
];

export async function diagnoseEnvironment({ manifest, network = true, execute = executeCommand, nodeVersion = process.versions.node, platform = process.platform } = {}) {
  const toolResults = await Promise.all(TOOL_SPECS.map(async (spec) => {
    const result = await execute(spec.name, spec.arguments, { cwd: tmpdir() });
    return { name: spec.name, requiredFor: "full", available: result.ok, version: result.ok ? firstVersion(result.stdout) : null };
  }));
  const checks = [
    { name: "node", requiredFor: "demo_and_full", available: meetsVersion(nodeVersion, REQUIRED_NODE_VERSION), version: nodeVersion, requiredVersion: `>=${REQUIRED_NODE_VERSION}` },
    { name: "platform", requiredFor: "full", available: platform !== "win32", version: platform, detail: platform === "win32" ? "Native Windows is unsupported because a pinned product check uses sh" : null },
    ...toolResults,
  ];
  const gitAvailable = toolResults.find((entry) => entry.name === "git")?.available === true;
  const repositories = [];
  if (network && gitAvailable && manifest) {
    const unique = new Map(Object.entries(manifest.repositories).map(([name, entry]) => [entry.url, { name, url: entry.url }]));
    repositories.push(...await Promise.all([...unique.values()].map(async (entry) => {
      const result = await execute("git", ["ls-remote", entry.url, "HEAD"]);
      return { name: entry.name, accessible: result.ok && /^[0-9a-f]{40}\s+HEAD\s*$/u.test(result.stdout.trim()) };
    })));
  }
  const localToolsReady = checks.every((entry) => entry.available);
  const repositoryAccessReady = network ? repositories.length === 3 && repositories.every((entry) => entry.accessible) : null;
  const outcome = !localToolsReady || repositoryAccessReady === false ? "not_ready" : network ? "ready" : "local_ready";
  return {
    version: 1,
    outcome,
    demoReady: checks[0].available,
    localToolsReady,
    fullAcceptanceReady: network ? localToolsReady && repositoryAccessReady === true : null,
    checks,
    repositoryAccess: { checked: network, ready: repositoryAccessReady, repositories },
    assurance: { localCommandsLimitedToVersionChecks: true, repositoryCheckUsesGitLsRemoteOnly: network, repositoryCodeExecuted: false, paidServiceUsed: false },
  };
}

export function meetsVersion(actual, required) {
  const left = parseVersion(actual);
  const right = parseVersion(required);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
}

export function formatDoctor(report) {
  const lines = [`Environment doctor: ${{ ready: "READY", local_ready: "LOCAL TOOLS READY", not_ready: "NOT READY" }[report.outcome]}`];
  for (const check of report.checks) {
    const detail = check.requiredVersion ? ` (requires ${check.requiredVersion})` : check.detail ? ` (${check.detail})` : "";
    lines.push(`  ${check.available ? "✓" : "✗"} ${check.name}: ${check.version ?? "missing"}${detail}`);
  }
  if (!report.repositoryAccess.checked) lines.push("  – Repository access: not checked (--offline)");
  else for (const repository of report.repositoryAccess.repositories) lines.push(`  ${repository.accessible ? "✓" : "✗"} repository: ${repository.name}`);
  lines.push(`  Demo: ${report.demoReady ? "ready" : "not ready"}`);
  lines.push(`  Full acceptance: ${report.fullAcceptanceReady === null ? "repository access not checked" : report.fullAcceptanceReady ? "ready" : "not ready"}`);
  return lines.join("\n");
}

function parseVersion(value) {
  const match = String(value).match(/(?:^|\s|v)(\d+)\.(\d+)(?:\.(\d+))?/u);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

function firstVersion(value) { return String(value).match(/\d+\.\d+(?:\.\d+)?/u)?.[0] ?? String(value).trim().slice(0, 80); }

async function executeCommand(command, arguments_, { cwd } = {}) {
  const result = await runChildProcess(command, arguments_, {
    cwd,
    timeoutMs: 10_000,
    killGraceMs: 500,
    stdoutLimit: 64 * 1024,
    stderrLimit: 16 * 1024,
  });
  return {
    ok: !result.spawnError && !result.timedOut && result.code === 0,
    stdout: result.stdout,
    stderr: result.spawnError ? result.spawnError.code ?? result.spawnError.message : result.stderr,
  };
}
