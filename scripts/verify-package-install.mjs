#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parsePackageSmokeArguments(arguments_) {
  if (arguments_.length === 0) return { onlineOnboard: false };
  if (arguments_.length === 1 && arguments_[0] === "--online-onboard") return { onlineOnboard: true };
  throw new Error("Usage: node scripts/verify-package-install.mjs [--online-onboard]");
}

export function assertPackageEntries(entries) {
  if (new Set(entries).size !== entries.length) throw new Error("Packed Kit contains duplicate archive entries");
  const requiredEntries = [
    "package/package.json", "package/README.md", "package/LICENSE", "package/SECURITY.md",
    "package/acceptance.lock.json", "package/bin/ecosystem-accept.mjs", "package/lib/onboard.mjs",
    "package/lib/runner.mjs", "package/docs/THREAT_MODEL.md", "package/CHANGELOG.md",
    "package/baselines/README.md", "package/baselines/acceptance-index.json", "package/lib/bootstrap.mjs",
    "package/lib/child-process.mjs", "package/lib/demo.mjs", "package/lib/doctor.mjs", "package/lib/index.mjs",
    "package/lib/manifest.mjs", "package/lib/preflight.mjs", "package/lib/receipt.mjs",
    "package/scripts/audit-secrets.mjs",
  ];
  for (const entry of requiredEntries) {
    if (!entries.includes(entry)) throw new Error(`Packed Kit is missing ${entry}`);
  }
  const fixed = new Set(requiredEntries);
  const unexpected = entries.filter((entry) => !fixed.has(entry) &&
    !/^package\/baselines\/v\d+\.\d+\.\d+\.lock\.json$/u.test(entry) &&
    !/^package\/baselines\/v\d+\.\d+\.\d+-to-v\d+\.\d+\.\d+\.preflight\.json$/u.test(entry));
  if (unexpected.length) throw new Error("Packed Kit contains files outside the release allowlist");
}

export function verifyPackageInstall({ onlineOnboard = false } = {}) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "ecosystem-kit-package-"));
  chmodSync(temporaryRoot, 0o700);
  try {
    const packDirectory = join(temporaryRoot, "pack");
    const consumer = join(temporaryRoot, "consumer");
    mkdirSync(packDirectory, { mode: 0o700 });
    mkdirSync(consumer, { mode: 0o700 });
    run("pnpm", ["--config.ignore-scripts=true", "pack", "--pack-destination", packDirectory], { cwd: root });
    const tarball = readdirSync(packDirectory).find((name) => name.endsWith(".tgz"));
    if (!tarball) throw new Error("pnpm pack did not create a tarball");
    const tarballPath = join(packDirectory, tarball);
    assertPackageEntries(run("tar", ["-tf", tarballPath]).stdout.trim().split("\n"));

    writeFileSync(join(consumer, "package.json"), '{"private":true,"type":"module"}\n', { mode: 0o600 });
    run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], {
      cwd: consumer, environment: { ...process.env, npm_config_cache: join(temporaryRoot, "npm-cache") },
    });
    const executable = join(consumer, "node_modules", ".bin", "ecosystem-accept");
    const expectedPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const installedPackage = JSON.parse(readFileSync(join(consumer, "node_modules", expectedPackage.name, "package.json"), "utf8"));
    if (installedPackage.name !== expectedPackage.name || installedPackage.version !== expectedPackage.version ||
        installedPackage.bin?.["ecosystem-accept"] !== "bin/ecosystem-accept.mjs") {
      throw new Error("Installed Kit package identity does not match the source package");
    }
    const help = run(executable, ["--help"], { cwd: consumer }).stdout;
    if (!help.includes("--exact-file FILE") || !help.includes("verify-receipt FILE")) {
      throw new Error("Installed Kit help is incomplete");
    }
    const onboardingDoctor = parseJson(run(executable, [
      "doctor", "--onboard", "--offline", "--json",
    ], { cwd: consumer }).stdout, "Installed Kit onboarding doctor");
    if (onboardingDoctor.scope !== "onboard" || onboardingDoctor.outcome !== "local_ready" ||
        onboardingDoctor.onboardingReady !== null || onboardingDoctor.repositoryAccess?.checked !== false ||
        onboardingDoctor.checks?.some((entry) => ["npm", "cargo"].includes(entry.name))) {
      throw new Error("Installed Kit onboarding doctor contract failed");
    }
    const demo = parseJson(run(executable, ["demo", "--json"], { cwd: consumer }).stdout, "Installed Kit demo");
    if (demo.version !== 1 || demo.outcome !== "demo_verified" || demo.assurance?.networkUsed !== false ||
        demo.assurance?.repositoryCodeExecuted !== false || demo.checks?.tamperRejected !== true) {
      throw new Error("Installed Kit demo contract failed");
    }
    const privateProbe = join(consumer, "must-not-appear.txt");
    const invalid = run(executable, ["onboard", "--source", privateProbe], { cwd: consumer, allowFailure: true });
    if (invalid.status === 0 || invalid.stderr.includes(privateProbe) ||
        !invalid.stderr.includes("missing required options")) {
      throw new Error("Installed Kit diagnostics leaked an input path or lost actionable guidance");
    }

    let onlineVerified = false;
    let repeatedAutomaticDirectoriesVerified = false;
    if (onlineOnboard) {
      const source = join(consumer, "source.txt");
      const exactFile = join(consumer, "exact.txt");
      const exact = "Installed package private onboarding observation.";
      writeFileSync(source, `${exact}\n`, { mode: 0o600 });
      writeFileSync(exactFile, exact, { mode: 0o600 });
      const workspace = join(consumer, "workspace");
      const directories = [];
      for (let position = 0; position < 2; position += 1) {
        const result = run(executable, [
          "onboard", "--workspace-root", workspace, "--source", source, "--exact-file", exactFile,
          "--available-at", "2026-07-14T00:00:00Z", "--promote-immediately", "--json",
        ], { cwd: consumer, timeoutMs: 120_000 });
        const report = parseJson(result.stdout, "Installed Kit onboard");
        const serialized = JSON.stringify(report);
        if (report.version !== 2 || report.outcome !== "first_evidence_ready" ||
            report.evidence?.outcome !== "verified" || report.scope?.allRepositoriesChecked !== false ||
            realpathSync(dirname(report.directory)) !== realpathSync(consumer) ||
            !/^evidence-\d{8}T\d{6}Z-[0-9a-f]{8}$/u.test(basename(report.directory)) ||
            serialized.includes(exact) || serialized.includes(source) || serialized.includes(exactFile)) {
          throw new Error("Installed Kit onboard contract failed");
        }
        directories.push(report.directory);
      }
      onlineVerified = true;
      repeatedAutomaticDirectoriesVerified = new Set(directories).size === 2;
      if (!repeatedAutomaticDirectoriesVerified) throw new Error("Installed Kit reused an automatic Evidence directory");
    }

    return {
      version: 1,
      kind: "EcosystemAcceptancePackageSmoke",
      outcome: "verified",
      checks: {
        packageAllowlistVerified: true,
        lifecycleScriptsDisabled: true,
        offlineInstallVerified: true,
        installedVersionVerified: true,
        installedHelpVerified: true,
        installedOnboardingDoctorVerified: true,
        installedDemoVerified: true,
        diagnosticRedactionVerified: true,
      },
      onlineOnboard: {
        checked: onlineOnboard,
        verified: onlineOnboard ? onlineVerified : null,
        repeatedAutomaticDirectoriesVerified: onlineOnboard ? repeatedAutomaticDirectoriesVerified : null,
      },
      assurance: { networkUsed: onlineOnboard, paidServiceInvoked: false, temporaryBytesRetained: false },
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function run(command, arguments_, {
  allowFailure = false, cwd = root, environment = process.env, timeoutMs = 30_000,
} = {}) {
  const result = spawnSync(command, arguments_, {
    cwd, env: environment, encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) throw new Error(`${command} failed during installed-package smoke`);
  return result;
}

function parseJson(source, label) {
  try { return JSON.parse(source); } catch { throw new Error(`${label} returned invalid JSON`); }
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const options = parsePackageSmokeArguments(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(verifyPackageInstall(options), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Installed-package smoke failed"}\n`);
    process.exitCode = 1;
  }
}
