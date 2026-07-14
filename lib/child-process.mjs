import { spawn } from "node:child_process";

const DEFAULT_KILL_GRACE_MS = 2_000;
const activeChildren = new Set();
const processExitCleanups = new Set();
let cleanupHandlersInstalled = false;

export async function runChildProcess(command, arguments_, {
  cwd,
  environment = process.env,
  environmentOverrides = {},
  timeoutMs,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  stdoutLimit = Number.POSITIVE_INFINITY,
  stderrLimit = Number.POSITIVE_INFINITY,
  terminateOnOutputLimit = [],
  onStdout,
  onStderr,
} = {}) {
  return await new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, arguments_, {
        cwd,
        env: { ...environment, ...environmentOverrides },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolvePromise(emptyResult(error));
      return;
    }
    trackChild(child);

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutExceeded = false;
    let stderrExceeded = false;
    let timedOut = false;
    let settled = false;
    let terminationStarted = false;
    let escalation;
    const terminatingStreams = terminateOnOutputLimit === true
      ? ["stdout", "stderr"]
      : terminateOnOutputLimit === false ? [] : terminateOnOutputLimit;

    const terminate = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      signalProcessTree(child, "SIGTERM");
      escalation = setTimeout(() => {
        signalProcessTree(child, "SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ signal: "SIGKILL" });
      }, killGraceMs);
      escalation.unref();
    };
    const timer = Number.isFinite(timeoutMs) ? setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs) : undefined;
    timer?.unref();

    const consume = (chunk, stream) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stream === "stdout") {
        onStdout?.(bytes);
        const captured = appendWithinLimit(stdout, bytes, stdoutLimit);
        stdout = captured.value;
        stdoutExceeded ||= captured.exceeded;
      } else {
        onStderr?.(bytes);
        const captured = appendWithinLimit(stderr, bytes, stderrLimit);
        stderr = captured.value;
        stderrExceeded ||= captured.exceeded;
      }
      if (terminatingStreams.includes(stream) && (stream === "stdout" ? stdoutExceeded : stderrExceeded)) terminate();
    };
    child.stdout.on("data", (chunk) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk) => consume(chunk, "stderr"));

    const finish = ({ code = null, signal = null, spawnError = null } = {}) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      clearTimeout(timer);
      if (timedOut || terminationStarted) signalProcessTree(child, "SIGKILL");
      clearTimeout(escalation);
      resolvePromise({
        code,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        stdoutExceeded,
        stderrExceeded,
        timedOut,
        spawnError,
      });
    };
    child.once("error", (error) => finish({ spawnError: error }));
    child.once("close", (code, signal) => finish({ code, signal }));
  });
}

function trackChild(child) {
  activeChildren.add(child);
  installCleanupHandlers();
}

export function registerProcessExitCleanup(cleanup) {
  if (typeof cleanup !== "function") throw new TypeError("cleanup must be a function");
  processExitCleanups.add(cleanup);
  installCleanupHandlers();
  return () => processExitCleanups.delete(cleanup);
}

function installCleanupHandlers() {
  if (cleanupHandlersInstalled) return;
  cleanupHandlersInstalled = true;
  process.once("SIGINT", () => exitAfterChildCleanup("SIGINT", 130));
  process.once("SIGTERM", () => exitAfterChildCleanup("SIGTERM", 143));
  process.once("exit", () => {
    killActiveChildren();
    runProcessExitCleanups();
  });
}

function exitAfterChildCleanup(signal, exitCode) {
  for (const child of activeChildren) signalProcessTree(child, signal);
  killActiveChildren();
  runProcessExitCleanups();
  process.exit(exitCode);
}

function runProcessExitCleanups() {
  const callbacks = [...processExitCleanups];
  processExitCleanups.clear();
  for (const cleanup of callbacks) {
    try { cleanup(); } catch {}
  }
}

function killActiveChildren() {
  for (const child of activeChildren) signalProcessTree(child, "SIGKILL");
}

function appendWithinLimit(current, chunk, limit) {
  if (!Number.isFinite(limit)) return { value: Buffer.concat([current, chunk]), exceeded: false };
  const remaining = Math.max(0, limit - current.length);
  return {
    value: remaining === 0 ? current : Buffer.concat([current, chunk.subarray(0, remaining)]),
    exceeded: chunk.length > remaining,
  };
}

function signalProcessTree(child, signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}

function emptyResult(error) {
  return {
    code: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutExceeded: false,
    stderrExceeded: false,
    timedOut: false,
    spawnError: error,
  };
}
