# Public release decision record

## Current status

The four clean-history public candidates are technically release-ready but
remain private. Their original private development repositories and histories
remain unchanged. No visibility, package registry, crate registry, deployment,
or announcement action is authorized by this document.

| Repository | License | Secret audit | Local release gate | Remaining blocker |
| --- | --- | --- | --- | --- |
| Agent Black Box OSS | MIT | Clean noreply history/tree | 25 tests; 9.6 KB packed CLI smoke | Explicit visibility approval |
| Sol Ledger Protocol OSS | MIT | Clean noreply history/tree | npm, TypeScript, Rust fmt/clippy/tests; crate metadata | Explicit visibility approval |
| Evidence Forge OSS | MIT | Clean noreply history/tree | Complete private-readiness receipt | Explicit visibility approval |
| Ecosystem Acceptance Kit OSS | MIT | Clean noreply history/tree; bounded hash rule; generated output excluded | 22 tests; packed demo/doctor; full clean-history acceptance | Explicit visibility approval |

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

The clean-history full acceptance receipt head is
`9daaff123d258229978b2eb39aceab1c1ffdcedc7c638682da2d0dd0d4f944f0` and the
four-entry retained index head is
`c720fc627d1cfcd696b8d4d0b3765b6e5fbcb5a4a7bd49004c4324165c278e43`.

## Publication order

1. Sol Ledger Protocol, because both products pin its contract.
2. Agent Black Box and Evidence Forge, after updating their public compatibility
   references to the chosen protocol repository.
3. Ecosystem Acceptance Kit, after replacing private URLs and exact revisions,
   running preflight, then completing a new full acceptance run.
4. Optional npm or crate publication only after separate package-name,
   provenance, and registry confirmation.

Immediately before each visibility or registry action, rerun Gitleaks history
and tree scans, the repository's documented full local gate, package-content
inspection, and the Ecosystem Acceptance Kit full run. Public visibility,
registry publication, and announcements each require fresh explicit approval.
