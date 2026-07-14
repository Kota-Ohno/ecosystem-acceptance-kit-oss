# Public release decision record

## Current status

The four clean-history public candidates are technically release-ready but
remain private. Their original private development repositories and histories
remain unchanged. No visibility, package registry, crate registry, deployment,
or announcement action is authorized by this document.

| Repository | License | Secret audit | Local release gate | Remaining blocker |
| --- | --- | --- | --- | --- |
| Agent Black Box OSS | MIT | Gitleaks history/tree clean; noreply-only authors | 42 tests; strict JSON/storage boundaries and packed CLI smoke | Explicit visibility approval |
| Sol Ledger Protocol OSS | MIT | Gitleaks history/tree clean; noreply-only authors | TypeScript generation/type/interop plus Rust fmt/clippy/tests | Explicit visibility approval |
| Evidence Forge OSS | MIT | Gitleaks history/tree clean; noreply-only authors | 45 Vitest files / 207 tests, 34 script tests, packed acceptance | Explicit visibility approval |
| Ecosystem Acceptance Kit OSS | MIT | Gitleaks history/tree clean; noreply-only authors | 65 tests, installed-tarball smoke, 34-step ecosystem acceptance | Explicit visibility approval |

The Gitleaks exceptions in the Kit are bounded to verified 64-hex
`previousEntrySha256` fields, one retained historical fingerprint, and the
ignored `.acceptance-output/` directory. They do not allow a credential pattern
globally, and generated output is absent from the npm package allowlist.

## Completed history decision

The selected strategy is a fresh snapshot in a separate `-oss` repository with
a GitHub noreply author. The original repositories were not rewritten, deleted,
renamed, or made public. `.mailmap` is not relied upon. The clean candidates use
new exact commit pins and preserve prior acceptance heads only as historical
evidence, not as executable public defaults.

## Clean-history relocation evidence

The v0.3.2→v0.4.0 preflight classified all repository locations as changed and
required manual contract review without executing repository code. Manual byte
comparison confirmed that the old private `v0.1.0` contract and clean-history
Sol Ledger contract have identical schema files:

- artifact-ref: `d06cacfbcf5f64244f3933dd9c525522817c4af74edd702fd3c598f57b60fcba`
- event-envelope: `833f4a7bee265ed78388b03e65d1b59df5d992cd40605fdffdd0b960d95f4bee`
- provenance-edge: `e3be46e852e55425a970d78cb2e71f9fb5cfbfdd262f0ce5595ee20989fabc02`
- security-policy: `2180eefea150b07a07ed420b88867027d874979f82a5b9a03802deb123cdd4bb`

The latest locally verified clean-history acceptance receipt head is
`43748b5a481a478aed1cc21693a6d4e5d4843e61303bcf864e63aed955265dba` and the
fourteen-entry retained index head is
`24378c4a8ee50aeece5688cdd764d7d3b2abb79b72119e564ee8fa71b433db67`.

## Current cross-repository audit

- Gitleaks 8.30.1 scanned every repository's full Git history and a clean
  archive of every tracked working-tree file with complete redaction; all eight
  scans returned zero findings.
- Every commit author email in the four clean repositories uses the GitHub
  noreply address. No tracked `.env`, `HANDOFF`, database, private key, archive,
  or session-memory artifact was found.
- `pnpm audit --prod` reports zero known production vulnerabilities in all four
  repositories. Production dependencies are MIT, BSD-2-Clause, or BSD-3-Clause;
  the other two Node packages have no production dependency.
- The products have no deployment manifest, hosted endpoint, telemetry
  transport, paid API integration, or cloud resource. The Review Workspace is
  loopback-only, and Evidence Forge remote capture is an explicit bounded fetch,
  so publishing source creates no running-cost or unauthenticated quota surface.
- All repositories contain MIT licenses. `Kota Ohno` is the intentionally public
  copyright-holder name used consistently across the four clean repositories.
- Registry publication remains independently disabled: Node manifests are
  `private: true`, and all three Sol Ledger Rust crates set `publish = false`.

## Publication order

1. Sol Ledger Protocol, because both products pin its contract.
2. Agent Black Box and Evidence Forge, after verifying their compatibility
   references resolve against the visible protocol repository.
3. Ecosystem Acceptance Kit, after pinning the visible repository heads,
   running preflight, then completing a new full acceptance run.
4. Optional npm or crate publication only after separate package-name,
   provenance, and registry confirmation.

Immediately before each visibility or registry action, rerun Gitleaks history
and tree scans, the repository's documented full local gate, package-content
inspection, and the Ecosystem Acceptance Kit full run. Public visibility,
registry publication, and announcements each require fresh explicit approval.
