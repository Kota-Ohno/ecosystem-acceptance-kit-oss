import assert from "node:assert/strict";
import test from "node:test";
import { assertPackageEntries, parsePackageSmokeArguments } from "./verify-package-install.mjs";

const required = [
  "package/package.json", "package/README.md", "package/LICENSE", "package/SECURITY.md",
  "package/acceptance.lock.json", "package/bin/ecosystem-accept.mjs", "package/lib/onboard.mjs",
  "package/lib/runner.mjs", "package/docs/PERFORMANCE.md", "package/docs/THREAT_MODEL.md", "package/CHANGELOG.md",
  "package/baselines/README.md", "package/baselines/acceptance-index.json", "package/lib/bootstrap.mjs",
  "package/lib/child-process.mjs", "package/lib/demo.mjs", "package/lib/doctor.mjs", "package/lib/index.mjs",
  "package/lib/evidence-runtime.mjs", "package/lib/evidence-verifier.mjs", "package/lib/manifest.mjs",
  "package/lib/preflight.mjs", "package/lib/receipt.mjs",
  "package/scripts/audit-secrets.mjs",
];

test("package smoke exposes only offline and explicit online modes", () => {
  assert.deepEqual(parsePackageSmokeArguments([]), { onlineOnboard: false });
  assert.deepEqual(parsePackageSmokeArguments(["--online-onboard"]), { onlineOnboard: true });
  assert.throws(() => parsePackageSmokeArguments(["--online"]), /Usage/u);
});

test("package allowlist requires runtime files and rejects development artifacts", () => {
  assert.doesNotThrow(() => assertPackageEntries(required));
  assert.throws(() => assertPackageEntries(required.filter((entry) => !entry.endsWith("onboard.mjs"))), /missing/u);
  assert.throws(() => assertPackageEntries([...required, "package/test/onboard.test.mjs"]), /outside the release allowlist/u);
  assert.throws(() => assertPackageEntries([...required, required[0]]), /duplicate/u);
});
