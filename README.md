# Ecosystem Acceptance Kit

Ecosystem Acceptance Kit is for maintainers and reviewers who want one local
answer to “do these exact private revisions still work together?” It offers a
seconds-fast offline demo, prerequisite diagnosis, and a revision-pinned full
acceptance run that produces a tamper-evident receipt.

It coordinates the Evidence Forge ecosystem:

- Agent Black Box captures a metadata-only execution trace.
- Sol Ledger verifies the shared event contract and hash chain.
- Evidence Forge exercises capture-to-promotion behavior from its packed artifact,
  produces a two-signer review bundle, and verifies a signed release evidence pack.

> **Installation status:** this repository is currently private and the package
> has `private: true`; it is not published to npm. Clone it from an account with
> access. pnpm is the supported package manager.

## Shortest path

```bash
git clone https://github.com/Kota-Ohno/ecosystem-acceptance-kit-oss.git
cd ecosystem-acceptance-kit-oss
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm demo
pnpm doctor
```

The repository pins pnpm 11.0.8. If `corepack` is unavailable but that pnpm
version is already installed, skip the `corepack enable` line.

`pnpm demo` is deterministic, uses only Node.js, performs no network access, and
proves that a synthetic receipt verifies while a mutation is rejected. It does
not claim that the real repositories passed. `pnpm doctor` checks the tools,
versions, GitHub access, and other prerequisites needed by full acceptance.

Create exact, clean checkouts of all three products with one command:

```bash
pnpm bootstrap --workspace-root ./evidence-stack
```

Bootstrap runs the offline demo and offline environment doctor, then checks out
the revisions pinned by `acceptance.lock.json` with visible progress. It does
not install dependencies, run product code, or replace an existing conflicting
checkout.

Existing checkouts are reused only when their revision, origin, and clean state
match the lock. Use `--json` when another tool consumes the final report;
progress remains on stderr so stdout stays machine-readable.

Bootstrap is for quick inspection and local product onboarding. Full acceptance
is deliberately separate: `pnpm accept` creates fresh disposable checkouts and
reinstalls dependencies rather than trusting or reusing the bootstrap workspace.
Running bootstrap therefore does not shorten a later full acceptance run.

## Everyday workflows

```bash
# Fast, offline confidence in the receipt verifier.
pnpm demo

# Diagnose all full-run prerequisites; use --offline to avoid GitHub access.
pnpm doctor
node bin/ecosystem-accept.mjs doctor --offline

# Inspect pinned work without executing repository code, then run acceptance.
pnpm plan
pnpm accept

# Re-verify a retained result later.
pnpm verify-receipt .acceptance-output/<run-id>/acceptance-receipt.json
```

Add `--json` to `demo` or `doctor` when another tool consumes the result.

If bootstrap fails during checkout, run networked `pnpm doctor` first. Confirm
GitHub credentials and private repository access, then rerun the same bootstrap
command. Failed temporary checkouts are removed; existing conflicting or dirty
directories are left unchanged.

## Role in the ecosystem

The kit is the integration and release-confidence layer. Agent Black Box owns
privacy-bounded trace capture, Sol Ledger owns the shared contract, and Evidence
Forge owns source-backed promotion. The kit clones the exact commits in
[`acceptance.lock.json`](acceptance.lock.json), runs their own checks, and binds
the results into one local receipt.

## Safety limits

- A successful receipt is interoperability evidence, not a sandbox, authorship
  proof, trusted timestamp, or proof that every product claim is true.
- Full acceptance clones and executes code from the pinned repositories. Review
  lock changes first and run only revisions you trust.
- The kit does not publish artifacts or send telemetry, but full acceptance does
  access GitHub and package registries. The demo is the offline path.
- Retain receipt heads through an independent channel and protect local output.
  Read the [threat model](docs/THREAT_MODEL.md) before relying on a result.

The lock distinguishes Sol Ledger's current implementation revision from the
stable v0.1.0 wire-contract revision pinned by both consumers. The former runs
the current product checks and packed acceptance; the latter runs Evidence
Forge's exact schema and Rust/JCS compatibility gate.

## Full acceptance requirements

- Node.js 24.4 or newer
- Git, pnpm, and a Rust toolchain with Cargo. npm is also checked because the
  packed-artifact compatibility suite deliberately verifies npm consumers.
- Read access to the three clean-history GitHub repositories while the public
  candidates remain private

The pinned repositories contain executable package and build code. Review a lock
change before running it; a successful receipt is interoperability evidence, not
a sandbox or an authorship attestation.

## Run full acceptance

```bash
pnpm accept
```

By default, temporary checkouts are removed and results are written under
`.acceptance-output/<run-id>/`. To retain the detached checkouts for diagnosis:

```bash
node bin/ecosystem-accept.mjs run --keep-workspace
```

Useful non-executing commands:

```bash
pnpm plan
pnpm compare acceptance.lock.json next.lock.json --output preflight.json
pnpm index append --receipt acceptance-receipt.json \
  --expected-receipt-sha256 RECEIPT_SHA256 --output acceptance-index-1.json
pnpm index verify --index acceptance-index-1.json \
  --expected-index-sha256 INDEX_SHA256
pnpm verify-receipt .acceptance-output/<run-id>/acceptance-receipt.json
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
pnpm test
pnpm check
pnpm audit:secrets
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
