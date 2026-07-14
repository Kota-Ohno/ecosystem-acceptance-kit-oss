import {
  accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { runOfflineDemo } from "./demo.mjs";
import { diagnoseEnvironment } from "./doctor.mjs";
import { repositoryNames } from "./manifest.mjs";
import { runChildProcess } from "./child-process.mjs";

const COMMAND_TIMEOUT_MS = 10 * 60_000;

export async function bootstrapWorkspace({
  manifest,
  workspaceRoot,
  reporter = () => {},
  command = executeCommand,
  demo = runOfflineDemo,
  diagnose = diagnoseEnvironment,
  sourceEnvironment = process.env,
  requiredTools = ["git"],
  repositorySelection = repositoryNames,
} = {}) {
  if (!manifest || !workspaceRoot) throw new TypeError("manifest and workspaceRoot are required");
  if (!Array.isArray(repositorySelection) || repositorySelection.length === 0 ||
      new Set(repositorySelection).size !== repositorySelection.length ||
      repositorySelection.some((name) => !repositoryNames.includes(name))) {
    throw new TypeError("repositorySelection must contain unique known repository names");
  }
  const selectedRepositories = [...repositorySelection];
  const workspace = resolve(workspaceRoot);
  const workspaceBoundary = canonicalFuturePath(workspace);
  const gitEnvironment = safeToolEnvironment(sourceEnvironment, [workspaceBoundary]);
  const toolCommands = Object.fromEntries(
    ["git", "npm", "pnpm", "cargo"].map((name) => [name, resolveToolExecutable(name, gitEnvironment.PATH, [workspaceBoundary])]),
  );
  const gitCommand = toolCommands.git;
  if (!gitCommand) throw new Error("Bootstrap could not resolve a trusted Git executable from PATH");
  const doctorExecute = createDoctorExecutor(toolCommands, gitEnvironment);
  ensureWorkspaceDirectory(workspace);
  const total = bootstrapProgressTotal(selectedRepositories);
  let position = 0;
  const step = async (name, operation) => {
    const current = position += 1;
    const started = Date.now();
    reporter({ state: "start", position: current, total, name });
    try {
      const value = await operation();
      reporter({ state: "done", position: current, total, name, durationMs: Date.now() - started });
      return value;
    } catch (error) {
      reporter({ state: "failed", position: current, total, name, durationMs: Date.now() - started });
      throw error;
    }
  };

  const demoReport = await step("offline-demo", async () => demo());
  const doctor = await step("environment-doctor", async () => {
    const report = await diagnose({ manifest, network: false, execute: doctorExecute });
    for (const name of requiredTools) {
      if (report.checks?.find((entry) => entry.name === name)?.available !== true) {
        throw new Error(`Bootstrap requires a supported ${name}; run pnpm doctor for details`);
      }
    }
    return report;
  });

  const repositories = {};
  for (const name of selectedRepositories) {
    const entry = manifest.repositories[name];
    repositories[name] = await step(`checkout:${name}`, () => ensureCheckout({
      name, entry, workspace, command, gitCommand, environment: gitEnvironment,
    }));
  }

  return {
    version: 1,
    outcome: "checkout_ready",
    mode: "checkout_only",
    workspace,
    demo: demoReport,
    doctor,
    repositories,
    assurance: {
      exactRevisionsChecked: true,
      allRepositoriesChecked: selectedRepositories.length === repositoryNames.length,
      cleanCheckoutsRequired: true,
      existingPathsReplaced: false,
      checkoutConfigurationHardened: true,
      repositoryCodeExecuted: false,
      dependenciesInstalled: false,
      buildScriptsExecuted: false,
      networkUsed: Object.values(repositories).some((entry) => entry.action === "created"),
      telemetryExported: false,
      paidServiceUsed: false,
    },
  };
}

export function bootstrapProgressTotal(repositorySelection = repositoryNames) {
  return 2 + repositorySelection.length;
}

export function formatBootstrap(report) {
  const lines = [
    "Pinned checkout workspace: READY",
    "  Mode: safe checkout only",
    `  Workspace: ${report.workspace}`,
    `  Offline demo: ${report.demo.outcome}`,
    `  Environment: ${report.doctor.outcome}`,
  ];
  for (const name of repositoryNames.filter((candidate) => report.repositories[candidate])) {
    const repository = report.repositories[name];
    lines.push(`  ✓ ${name}: ${repository.revision.slice(0, 12)} (${repository.action})`);
  }
  lines.push("  No repository code, dependency install, or build script was executed.");
  lines.push("  Full acceptance is separate: run pnpm doctor, then pnpm accept.");
  return lines.join("\n");
}

export function textBootstrapReporter(write) {
  return ({ state, position, total, name, durationMs }) => {
    const marker = state === "start" ? "▶" : state === "done" ? "✓" : "✗";
    const duration = state === "start" ? "" : ` (${(durationMs / 1000).toFixed(1)}s)`;
    write(`[${String(position).padStart(2, "0")}/${String(total).padStart(2, "0")}] ${marker} ${name}${duration}\n`);
  };
}

async function ensureCheckout({
  name, entry, workspace, destination = join(workspace, name), fetchSource = "origin", command, gitCommand, environment,
}) {
  if (existsSync(destination)) {
    await verifyPinnedCheckout({ name, entry, path: destination, command, gitCommand, environment });
    return { path: destination, revision: entry.revision, action: "reused" };
  }

  mkdirSync(destination, { mode: 0o700 });
  try {
    await runChecked(command, gitCommand, ["init", "--quiet", "--template="], { cwd: destination, environment });
    await runChecked(command, gitCommand, ["config", "core.hooksPath", "/dev/null"], { cwd: destination, environment });
    await runChecked(command, gitCommand, ["remote", "add", "origin", entry.url], { cwd: destination, environment });
    await runChecked(command, gitCommand, ["fetch", "--quiet", "--depth=1", fetchSource, entry.revision], { cwd: destination, environment });
    await assertNoCheckoutFilters({ path: destination, revision: "FETCH_HEAD", command, gitCommand, environment });
    await runChecked(command, gitCommand, ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: destination, environment });
    await verifyCheckout({ name, entry, path: destination, command, gitCommand, environment });
    return { path: destination, revision: entry.revision, action: "created" };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function createPinnedCheckout({ name, entry, destination, fetchSource = "origin", command, gitCommand, environment }) {
  if (existsSync(destination)) throw new Error(`${name} execution checkout path already exists`);
  return ensureCheckout({ name, entry, workspace: dirname(destination), destination, fetchSource, command, gitCommand, environment });
}

async function verifyCheckout({ name, entry, path, command, gitCommand, environment }) {
  const head = (await runChecked(command, gitCommand, ["rev-parse", "HEAD"], { cwd: path, environment })).stdout.trim();
  const topLevel = (await runChecked(command, gitCommand, ["rev-parse", "--show-toplevel"], { cwd: path, environment })).stdout.trim();
  const gitDirectory = (await runChecked(command, gitCommand, ["rev-parse", "--absolute-git-dir"], { cwd: path, environment })).stdout.trim();
  const dirty = (await runChecked(command, gitCommand, ["status", "--porcelain", "--untracked-files=all"], { cwd: path, environment })).stdout.trim();
  const remote = (await runChecked(command, gitCommand, ["remote", "get-url", "origin"], { cwd: path, environment })).stdout.trim();
  if (head !== entry.revision) throw new Error(`${name} exists at a different revision; it was left unchanged`);
  if (realpathSync(topLevel) !== realpathSync(path) || realpathSync(gitDirectory) !== realpathSync(join(path, ".git"))) {
    throw new Error(`${name} uses Git metadata for a different worktree; it was left unchanged`);
  }
  if (dirty) throw new Error(`${name} checkout is dirty; it was left unchanged`);
  if (remote !== entry.url) throw new Error(`${name} uses a different origin URL; it was left unchanged`);
}

export async function verifyPinnedCheckout({ name, entry, path, command, gitCommand, environment }) {
  refuseUnsafeDirectory(path, `${name} checkout`);
  refuseUnsafeDirectory(join(path, ".git"), `${name} .git directory`);
  await assertNoCheckoutFilters({ path, revision: "HEAD", command, gitCommand, environment });
  await verifyCheckout({ name, entry, path, command, gitCommand, environment });
}

async function assertNoCheckoutFilters({ path, revision, command, gitCommand, environment }) {
  assertNoLocalCheckoutFilters(path);
  const tree = await runChecked(command, gitCommand, ["ls-tree", "-r", "--name-only", revision], { cwd: path, environment });
  const attributePaths = tree.stdout.split("\n").filter((entry) => entry === ".gitattributes" || entry.endsWith("/.gitattributes"));
  for (const attributePath of attributePaths) {
    const source = await runChecked(command, gitCommand, ["show", `${revision}:${attributePath}`], { cwd: path, environment });
    if (hasFilterAttribute(source.stdout)) {
      throw new Error(`Checkout refused because ${attributePath} can invoke a configured content filter`);
    }
  }
}

function assertNoLocalCheckoutFilters(path) {
  const attributes = join(path, ".git", "info", "attributes");
  if (!existsSync(attributes)) return;
  const metadata = lstatSync(attributes);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) {
    throw new Error("Checkout refused because .git/info/attributes is not a bounded regular file");
  }
  if (hasFilterAttribute(readFileSync(attributes, "utf8"))) {
    throw new Error("Checkout refused because .git/info/attributes can invoke a configured content filter");
  }
}

function hasFilterAttribute(source) {
  return source.split("\n").some((line) => !line.startsWith("#") && /(?:^|\s)[!-]?filter(?:=|\s|$)/u.test(line));
}

function ensureWorkspaceDirectory(path) {
  if (existsSync(path)) {
    refuseUnsafeDirectory(path, "workspace root");
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function refuseUnsafeDirectory(path, label) {
  if (!existsSync(path)) throw new Error(`${label} must be a real directory; existing path was left unchanged`);
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory; existing path was left unchanged`);
  }
}

export function safeToolEnvironment(source, excludedRoots = []) {
  const allowed = [
    "PATH", "LANG", "LC_ALL", "TERM", "SYSTEMROOT", "WINDIR",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "GIT_SSL_CAINFO",
    "SSH_AUTH_SOCK",
  ];
  const pathEntries = String(source.PATH ?? "").split(delimiter);
  if (pathEntries.length === 0 || pathEntries.some((entry) => entry.length === 0 || !isAbsolute(entry))) {
    throw new Error("Bootstrap requires PATH to contain only absolute directories");
  }
  const safePathEntries = pathEntries.filter((entry) => {
    const candidate = canonicalFuturePath(entry);
    return !excludedRoots.some((root) => candidate === root || candidate.startsWith(`${root}${sep}`));
  });
  if (safePathEntries.length === 0) throw new Error("Bootstrap PATH has no trusted directory outside the workspace");
  return {
    ...Object.fromEntries(allowed.filter((name) => source[name] !== undefined).map((name) => [name, source[name]])),
    ...(source.HOME === undefined ? {} : { HOME: source.HOME }),
    PATH: safePathEntries.join(delimiter),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "core.attributesFile",
    GIT_CONFIG_VALUE_2: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

export function resolveToolExecutable(name, pathValue, excludedRoots = []) {
  const roots = Array.isArray(excludedRoots) ? excludedRoots : [excludedRoots];
  const names = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const directory of String(pathValue).split(delimiter)) {
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        accessSync(candidate, constants.X_OK);
        const resolved = realpathSync(candidate);
        if (!lstatSync(resolved).isFile()) continue;
        if (roots.some((root) => resolved === root || resolved.startsWith(`${root}${sep}`))) continue;
        return resolved;
      } catch {
        // Continue to the next PATH candidate.
      }
    }
  }
  return null;
}

export function canonicalFuturePath(path) {
  const suffix = [];
  let existing = path;
  while (!existsSync(existing)) {
    suffix.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return join(realpathSync(existing), ...suffix);
}

function createDoctorExecutor(commands, environment) {
  return async (name, arguments_, { cwd } = {}) => {
    const executable = commands[name];
    if (!executable) return { ok: false, stdout: "", stderr: "tool is unavailable" };
    const result = await runChildProcess(executable, arguments_, {
      cwd,
      environment,
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
  };
}

async function runChecked(command, executable, arguments_, options) {
  const result = await command(executable, arguments_, options);
  if (result.spawnError) throw result.spawnError;
  if (result.timedOut) throw new Error(`${executable} timed out`);
  if (result.code !== 0) throw new Error(commandFailure(executable, arguments_, result));
  if (result.stdoutExceeded || result.stderrExceeded) throw new Error(`${executable} output exceeded the bootstrap limit`);
  return result;
}

function commandFailure(executable, arguments_, result) {
  const displayExecutable = basename(executable);
  const operation = arguments_[0] ? `${displayExecutable} ${arguments_[0]}` : displayExecutable;
  if (!/^git(?:\.exe|\.cmd)?$/iu.test(displayExecutable) || arguments_[0] !== "fetch") {
    return `${operation} exited with ${result.code ?? result.signal}`;
  }
  const details = String(result.stderr).toLowerCase();
  if (/authentication failed|could not read username|permission denied|repository not found/u.test(details)) {
    return "git fetch failed because private repository access was denied; verify GitHub credentials and run pnpm doctor";
  }
  if (/could not resolve host|failed to connect|connection timed out|network is unreachable|ssl|tls/u.test(details)) {
    return "git fetch failed because the network or TLS connection was unavailable; check connectivity and run pnpm doctor";
  }
  if (/not our ref|couldn't find remote ref|unadvertised object|server does not allow request/u.test(details)) {
    return "git fetch failed because the pinned revision was unavailable; verify the manifest and repository access";
  }
  return `git fetch exited with ${result.code ?? result.signal}; verify network, private GitHub access, and the pinned revision with pnpm doctor`;
}

async function executeCommand(command, arguments_, { cwd, environment } = {}) {
  return runChildProcess(command, arguments_, {
    cwd,
    environment,
    timeoutMs: COMMAND_TIMEOUT_MS,
    stdoutLimit: 1024 * 1024,
    stderrLimit: 256 * 1024,
    terminateOnOutputLimit: true,
  });
}
