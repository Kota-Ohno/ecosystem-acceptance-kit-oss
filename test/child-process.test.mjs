import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { runChildProcess } from "../lib/child-process.mjs";

test("captures strictly bounded stdout and stderr", async () => {
  const result = await runChildProcess(process.execPath, ["-e", "process.stdout.write('a'.repeat(100));process.stderr.write('b'.repeat(100))"], {
    stdoutLimit: 17,
    stderrLimit: 23,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "a".repeat(17));
  assert.equal(result.stderr, "b".repeat(23));
  assert.equal(result.stdoutExceeded, true);
  assert.equal(result.stderrExceeded, true);
});

test("reports timeout after terminating a long-running child", async () => {
  const started = Date.now();
  const result = await runChildProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    timeoutMs: 25,
    killGraceMs: 25,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 1_000);
});

test("timeout settles when a detached descendant keeps output pipes open", { timeout: 4_000 }, async (context) => {
  if (process.platform === "win32") { context.skip("POSIX process groups are required"); return; }
  const root = mkdtempSync(join(tmpdir(), "ecosystem-escaped-child-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const pidPath = join(root, "escaped.pid");
  const escaped = "setInterval(()=>{},1000)";
  const parent = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(escaped)}],{detached:true,stdio:['ignore',1,2]});require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(child.pid));setInterval(()=>{},1000)`;
  const started = Date.now();
  const execution = runChildProcess(process.execPath, ["-e", parent], { timeoutMs: 300, killGraceMs: 100 });
  await waitForFile(pidPath);
  const result = await execution;
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 1_000);
  const escapedPid = Number(readFileSync(pidPath, "utf8"));
  try { process.kill(escapedPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
});

test("SIGTERM cleanup kills an active detached process group", { timeout: 4_000 }, async (context) => {
  if (process.platform === "win32") { context.skip("POSIX process groups are required"); return; }
  const root = mkdtempSync(join(tmpdir(), "ecosystem-signal-cleanup-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const pidPath = join(root, "active.pid");
  const worker = "require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const moduleUrl = new URL("../lib/child-process.mjs", import.meta.url).href;
  const helperCode = `import(${JSON.stringify(moduleUrl)}).then(({runChildProcess})=>runChildProcess(process.execPath,['-e',${JSON.stringify(worker)},${JSON.stringify(pidPath)}],{timeoutMs:60000}))`;
  const helper = spawn(process.execPath, ["-e", helperCode], { stdio: "ignore" });
  await waitForFile(pidPath);
  helper.kill("SIGTERM");
  const helperExit = await new Promise((resolve) => helper.once("close", (code, signal) => resolve({ code, signal })));
  assert.equal(helperExit.code, 143);
  const workerPid = Number(readFileSync(pidPath, "utf8"));
  await waitForStopped(workerPid);
  assert.equal(processIsRunning(workerPid), false);
});

test("applies explicit environment overrides", async () => {
  const result = await runChildProcess(process.execPath, ["-e", "process.stdout.write(process.env.SHARED_PROCESS_TEST ?? '')"], {
    environment: {},
    environmentOverrides: { SHARED_PROCESS_TEST: "isolated" },
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "isolated");
});

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for child pid file");
}

async function waitForStopped(pid) {
  for (let attempt = 0; attempt < 100 && processIsRunning(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processIsRunning(pid) {
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2, stat.lastIndexOf(") ") + 3) !== "Z";
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
