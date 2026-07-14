# Ecosystem Acceptance Kit

Fast offline proof plus revision-pinned full acceptance for the Evidence Forge ecosystem:

- Agent Black Box captures a metadata-only execution trace.
- Sol Ledger verifies the shared event contract and hash chain.
- Evidence Forge exercises capture-to-promotion behavior from its packed artifact,
  produces a two-signer review bundle, and verifies a signed release evidence pack.

The kit clones the exact commits in [`acceptance.lock.json`](acceptance.lock.json),
runs the repositories' own checks, and writes a tamper-evident local receipt. It
does not publish artifacts or contact a telemetry service.

The lock distinguishes Sol Ledger's current implementation revision from the
stable v0.1.0 wire-contract revision pinned by both consumers. The former runs
the current product checks and packed acceptance; the latter runs Evidence
Forge's exact schema and Rust/JCS compatibility gate.

## Try it in seconds

```bash
git clone https://github.com/Kota-Ohno/ecosystem-acceptance-kit-oss.git
cd ecosystem-acceptance-kit
npm run demo
```

The deterministic demo uses only Node.js. It verifies a synthetic three-product
receipt, proves that mutation is rejected, performs no network access, and makes
no full-acceptance claim. Check every full-run prerequisite and private repository
access in one pass with:

```bash
npm run doctor
```

Use `node bin/ecosystem-accept.mjs doctor --offline` to check local tools without
contacting GitHub. Add `--json` to either `demo` or `doctor` for automation.

## Full acceptance requirements

- Node.js 24.4 or newer
- Git, npm, pnpm, and a Rust toolchain with Cargo
- Read access to the three clean-history GitHub repositories while the public
  candidates remain private

The pinned repositories contain executable package and build code. Review a lock
change before running it; a successful receipt is interoperability evidence, not
a sandbox or an authorship attestation.

## Run full acceptance

```bash
npm run accept
```

By default, temporary checkouts are removed and results are written under
`.acceptance-output/<run-id>/`. To retain the detached checkouts for diagnosis:

```bash
node bin/ecosystem-accept.mjs run --keep-workspace
```

Useful non-executing commands:

```bash
npm run plan
npm run compare -- acceptance.lock.json next.lock.json --output preflight.json
npm run index -- append --receipt acceptance-receipt.json \
  --expected-receipt-sha256 RECEIPT_SHA256 --output acceptance-index-1.json
npm run index -- verify --index acceptance-index-1.json \
  --expected-index-sha256 INDEX_SHA256
npm run verify-receipt -- .acceptance-output/<run-id>/acceptance-receipt.json
```

`plan` validates and prints the pinned inputs without cloning or executing them.
`compare` fetches exact commits without executing repository code, classifies
product/protocol/schema/acceptance paths, and fails closed to manual review for
wire-contract, schema, or repository-location changes. A changed lock always
requires a new full acceptance run; preflight is not semantic compatibility proof.
`verify-receipt` recomputes the receipt's canonical SHA-256 integrity value.

`index append` requires the receipt head as a separate argument, rejects failed
receipts and duplicates, and writes a new file instead of mutating an old index.
Every entry binds the prior entry, exact revisions, and retained artifact heads.
The tool enforces the supplied anchor but cannot attest that it came through an
independent channel; operators retain that responsibility.

## Output

The result directory is private (`0700`) and contains:

- `acceptance-receipt.json` (`0600`): revisions, completed steps, artifact
  digests, assurance limits, and its own canonical integrity hash.
- `stack/`: Evidence Forge's private packed-acceptance artifacts. Ephemeral
  signing private keys are removed after the acceptance succeeds; public keys,
  signatures, trust material, and verifiable packs remain.

The receipt intentionally excludes checkout paths, command output, private keys,
and trusted key IDs. It records `timestampAttested: false`; local wall-clock time
is not a trusted timestamp.

Versioned prior locks, upgrade preflight evidence, and the path-free retained
receipt index live under [`baselines/`](baselines/README.md). The index preserves
heads and exact revisions, not the original private acceptance artifacts.

## Development

```bash
npm test
npm run check
npm run audit:secrets
```

The secret audit requires Gitleaks and scans both complete Git history and the
working tree with redacted output. Generated `.acceptance-output/` directories
are excluded because they are ignored, local-only run artifacts; they are never
part of the package allowlist.

See the [changelog](CHANGELOG.md), [threat model](docs/THREAT_MODEL.md), and
[roadmap](docs/ROADMAP.md). Security reports follow [SECURITY.md](SECURITY.md),
contributions follow [CONTRIBUTING.md](CONTRIBUTING.md), and the ecosystem-wide
publication order and blockers are tracked in
[the public release decision record](docs/PUBLIC_RELEASE.md).

## License

MIT
