import assert from "node:assert/strict";
import test from "node:test";
import manifest from "../acceptance.lock.json" with { type: "json" };
import { diagnoseEnvironment, formatDoctor, meetsVersion } from "../lib/doctor.mjs";

const successful = async (command, arguments_) => ({ ok: true, stdout: command === "git" && arguments_[0] === "ls-remote" ? `${"a".repeat(40)}\tHEAD\n` : `${command} version 1.2.3\n`, stderr: "" });

test("compares complete semantic versions", () => {
  assert.equal(meetsVersion("24.4.0", "24.4.0"), true);
  assert.equal(meetsVersion("v26.0.0", "24.4.0"), true);
  assert.equal(meetsVersion("24.3.9", "24.4.0"), false);
  assert.equal(meetsVersion("unknown", "24.4.0"), false);
});

test("doctor aggregates tools and repository access without running repository code", async () => {
  const report = await diagnoseEnvironment({ manifest, execute: successful, nodeVersion: "24.4.0", platform: "darwin", network: true });
  assert.equal(report.outcome, "ready");
  assert.equal(report.demoReady, true);
  assert.equal(report.fullAcceptanceReady, true);
  assert.equal(report.repositoryAccess.repositories.length, 3);
  assert.equal(report.assurance.repositoryCodeExecuted, false);
  assert.match(formatDoctor(report), /Full acceptance: ready/u);
});

test("doctor reports every missing prerequisite in one result", async () => {
  const missing = async (command) => ({ ok: command === "git", stdout: command === "git" ? "git version 2.0.0" : "", stderr: "missing" });
  const report = await diagnoseEnvironment({ manifest, execute: missing, nodeVersion: "22.0.0", platform: "win32", network: false });
  assert.equal(report.outcome, "not_ready");
  assert.equal(report.checks.filter((entry) => !entry.available).length, 5);
  assert.equal(report.repositoryAccess.checked, false);
});

test("offline doctor distinguishes local readiness from full readiness", async () => {
  const report = await diagnoseEnvironment({ manifest, execute: successful, nodeVersion: "24.4.0", platform: "linux", network: false });
  assert.equal(report.outcome, "local_ready");
  assert.equal(report.localToolsReady, true);
  assert.equal(report.fullAcceptanceReady, null);
  assert.match(formatDoctor(report), /repository access not checked/u);
});

test("doctor fails closed when a repository cannot be reached", async () => {
  const inaccessible = async (command, arguments_) => command === "git" && arguments_[0] === "ls-remote" ? { ok: false, stdout: "", stderr: "denied" } : successful(command, arguments_);
  const report = await diagnoseEnvironment({ manifest, execute: inaccessible, nodeVersion: "24.4.0", platform: "linux", network: true });
  assert.equal(report.outcome, "not_ready");
  assert.equal(report.fullAcceptanceReady, false);
  assert.equal(report.assurance.repositoryCodeExecuted, false);
});

test("onboarding doctor ignores unrelated full-acceptance tools and repositories", async () => {
  const calls = [];
  const execute = async (command, arguments_) => {
    calls.push([command, ...arguments_]);
    return successful(command, arguments_);
  };
  const report = await diagnoseEnvironment({
    manifest, execute, nodeVersion: "24.4.0", platform: "darwin", network: true, scope: "onboard",
  });
  assert.equal(report.outcome, "ready");
  assert.equal(report.scope, "onboard");
  assert.equal(report.onboardingReady, true);
  assert.equal(report.fullAcceptanceReady, null);
  assert.deepEqual(report.checks.map((entry) => entry.name), ["node", "platform", "git", "pnpm"]);
  assert.deepEqual(report.repositoryAccess.repositories.map((entry) => entry.name), ["evidenceForge"]);
  assert.equal(calls.some(([command]) => ["npm", "cargo"].includes(command)), false);
  assert.match(formatDoctor(report), /Onboarding: ready/u);
});

test("offline onboarding doctor reports local readiness without claiming repository access", async () => {
  const report = await diagnoseEnvironment({
    manifest, execute: successful, nodeVersion: "24.4.0", platform: "linux", network: false, scope: "onboard",
  });
  assert.equal(report.outcome, "local_ready");
  assert.equal(report.onboardingReady, null);
  assert.equal(report.repositoryAccess.repositories.length, 0);
});
