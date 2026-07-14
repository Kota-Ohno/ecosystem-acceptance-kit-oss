import assert from "node:assert/strict";
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

test("applies explicit environment overrides", async () => {
  const result = await runChildProcess(process.execPath, ["-e", "process.stdout.write(process.env.SHARED_PROCESS_TEST ?? '')"], {
    environment: {},
    environmentOverrides: { SHARED_PROCESS_TEST: "isolated" },
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "isolated");
});
