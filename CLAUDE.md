# Project guidance

Preserve the Kit's invariant that caller source and exact-quote bytes are never
copied into progress, diagnostics, or the final Kit report.

## Sensitive paths (trust boundary)

Changes touching a glob below are not complete until that row's ritual passes.
Do not weaken or edit this table in the same change that modifies a listed path.

| Paths | Why it is a boundary | Ritual (tests to extend) | Verify command | Runtime |
| --- | --- | --- | --- | --- |
| `bin/ecosystem-accept.mjs`, `lib/onboard.mjs`, `lib/evidence-runtime.mjs`, `lib/evidence-verifier.mjs` | Caller source, quote, retained packet, and expected digest cross into pinned executable product code; a bug can leak content, select the wrong bytes, or overstate verification. | Add a dedicated case to `test/onboard.test.mjs` for every new input mode, including mutual exclusion, child argv, closed output/error contracts, report redaction, identity checks, and cleanup; extend `scripts/verify-package-install.mjs` for the real installed path. | `pnpm check && pnpm smoke:package:onboard && pnpm audit:secrets` | Packed npm tarball installed with lifecycle scripts disabled, executing the pinned private Evidence Forge revision. |
| `lib/child-process.mjs` | Every product command and captured output crosses this process-isolation boundary. | Add a dedicated case to `test/child-process.test.mjs` covering timeout, output bounds, process-group cleanup, or environment behavior being changed. | `pnpm check` | Real local Node.js process tree, not a mocked child-process adapter. |
