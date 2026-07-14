# Ecosystem Acceptance Kit

Ecosystem Acceptance Kit is for maintainers and reviewers who want one local
answer to “do these exact pinned revisions still work together?” It offers a
seconds-fast offline demo, prerequisite diagnosis, and a revision-pinned full
acceptance run that produces a tamper-evident receipt.

It coordinates the Evidence Forge ecosystem:

- Agent Black Box captures a metadata-only execution trace.
- Sol Ledger verifies the shared event contract and hash chain.
- Evidence Forge exercises capture-to-promotion behavior from its packed artifact,
  produces a two-signer review bundle, and verifies a signed release evidence pack.

> **Distribution status:** install from this source repository with pnpm. The
> package remains `private: true` and is not published to npm, which prevents an
> accidental registry release while keeping source installation supported.
> Before repository visibility is public, cloning requires authorized GitHub
> access; after visibility changes, the same source-install steps work anonymously.

## Shortest path

```bash
git clone https://github.com/Kota-Ohno/ecosystem-acceptance-kit-oss.git
cd ecosystem-acceptance-kit-oss
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm demo
pnpm doctor --onboard
```

The repository pins pnpm 11.0.8. If `corepack` is unavailable but that pnpm
version is already installed, skip the `corepack enable` line.

`pnpm demo` is deterministic, uses only Node.js, performs no network access, and
proves that a synthetic receipt verifies while a mutation is rejected. It does
not claim that the real repositories passed. `pnpm doctor --onboard` checks only
Node.js, Git, pnpm, the supported OS, and Evidence Forge access. Plain
`pnpm doctor` keeps the broader npm, Cargo, and three-repository checks needed by
full acceptance.

Run the local tutorial and create a verified packet with one command:

```bash
pnpm onboard
```

`onboard` shows eight progress steps, prepares the exact pinned Evidence Forge checkout,
installs Evidence Forge dependencies with lifecycle scripts disabled, and runs
its local-only tutorial from a fresh disposable execution checkout. Caller-source
mode runs the pinned local-file workflow instead. Both modes then run a separate
packet-verification pass, revalidate the pinned clean checkout, and remove every
disposable execution byte. The result is written to
`./my-first-evidence`; the inspection-only Evidence Forge checkout remains in
`./evidence-ecosystem-workspace`.

When the entire local text file is the observation, the shortest private path is:

```bash
pnpm --silent onboard \
  --source ./notes.txt \
  --cite-entire-source \
  --available-at 2026-07-11T00:00:00Z \
  --promote-immediately
```

The whole-file citation must be non-empty UTF-8, at most 64 KiB, and contain
neither a UTF-8 BOM nor NUL. The Kit checks this before checkout or dependency
installation, so invalid input fails quickly without network or bootstrap work.

To cite only one excerpt, replace `--cite-entire-source` with
`--exact-file ./private-exact.txt`. Create that file as mode-0600 UTF-8 without
placing its literal content in shell history; Evidence Forge reads it with a
bounded, no-symlink contract. `--exact TEXT` remains available for compatibility.
`--promote-immediately` preauthorizes promotion before the Candidate exists;
this shortest path does not pause for human Candidate inspection. The final
Kit report omits the source path and quote, while the private Evidence output
retains the source snapshot and citation needed for verification. Keep
`--silent` so pnpm itself does not echo caller arguments. Use Evidence Forge's
separate `capture` then `promote` commands when Candidate inspection is required.
Caller-source mode chooses a new `evidence-YYYYMMDDTHHMMSSZ-xxxxxxxx` directory
under the current directory when `--directory` is omitted; this timestamp is only
an organizational filename and is not trusted Evidence time. Pass
`--directory ./my-evidence` when a specific new path is desired.

Keep the printed packet SHA-256 somewhere independent of the Evidence directory.
Later, re-verify the retained packet through a Kit workflow that does not write
to the Evidence directory:

```bash
pnpm verify-evidence \
  --directory ./my-evidence \
  --expected-sha256 <independently-kept-packet-sha256>
```

This shows eight progress steps, runs the verifier from a fresh checkout of the
pinned Evidence Forge revision, installs dependencies with lifecycle scripts
disabled, and removes the disposable checkout. It may access GitHub and the
package registry; the persistent checkout and pnpm store make repeats cheaper.
The Kit requires the expected digest argument but cannot verify where you stored
or obtained it; independence is an operator practice, not a machine claim.
Text-mode onboarding prints this command with the installed Kit directory,
exact workspace, output directory, and digest already filled in and safely
quoted for POSIX shells, so it can be copied and run from any directory. JSON
mode remains a closed machine contract and does not add presentation-only
command text.

Unlike `demo` and `bootstrap`, onboarding intentionally executes the pinned
Evidence Forge workflow and may access GitHub and the package registry. It
has no configured paid-service integration and does not overwrite an existing
Evidence directory.
Onboarding currently supports macOS and Linux; native Windows is rejected before
checkout because the wider acceptance stack contains shell-based checks.
Onboarding fetches only Evidence Forge because the other products are not used
to author this packet. Use `bootstrap` below when all three inspection checkouts
are wanted. Choose fresh locations explicitly when the defaults already exist:

```bash
pnpm onboard --workspace-root ./evidence-stack --directory ./evidence-run-2
```

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
Tutorial onboarding retains its version 1 JSON shape. Caller-source onboarding
uses version 2 with `workflow: "local_file"` and a closed path-free `evidence`
result plus `scope: { repositoriesChecked: ["evidenceForge"],
allRepositoriesChecked: false }`. The text result carries the same scope warning,
so a reused workspace cannot imply that Agent Black Box or Sol Ledger was checked.

Bootstrap is for quick inspection and local product onboarding. Full acceptance
is deliberately separate: `pnpm accept` creates fresh disposable checkouts and
reinstalls dependencies rather than trusting or reusing the bootstrap workspace.
Running bootstrap therefore does not shorten a later full acceptance run.

## Everyday workflows

```bash
# Fast, offline confidence in the receipt verifier.
pnpm demo

# One-command tutorial packet.
pnpm onboard

# One-command packet from a caller-selected local source.
pnpm --silent onboard --source ./notes.txt --cite-entire-source \
  --available-at 2026-07-11T00:00:00Z --promote-immediately

# Re-verify retained Evidence against the independently kept packet digest.
pnpm verify-evidence --directory ./my-evidence --expected-sha256 <sha256>

# Diagnose all full-run prerequisites; use --offline to avoid GitHub access.
pnpm doctor
node bin/ecosystem-accept.mjs doctor --offline

# Diagnose only the lightweight Evidence onboarding path.
pnpm doctor --onboard

# Verify the actual tarball offline; this is also part of pnpm check.
pnpm smoke:package

# Release-candidate smoke through the installed tarball and pinned source repo.
# Its JSON includes non-gating first/repeat/verification timing samples.
pnpm smoke:package:onboard

# Inspect pinned work without executing repository code, then run acceptance.
pnpm plan
pnpm accept

# Re-verify a retained result later.
pnpm verify-receipt .acceptance-output/<run-id>/acceptance-receipt.json
```

The current repeatable scenario and three-sample baseline are recorded in
[`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).

Add `--json` to `demo` or `doctor` when another tool consumes the result.

If bootstrap fails during checkout, run networked `pnpm doctor` first. When a
pinned repository is access-restricted, confirm GitHub credentials, then rerun
the same bootstrap command. Failed temporary checkouts are removed; existing
conflicting or dirty directories are left unchanged.

If onboarding fails, its inspection checkout and any completed Evidence output
remain visible rather than being silently replaced; its disposable execution
checkout is removed. Resolve the reported prerequisite or checkout issue, then
rerun with a new `--directory`; a matching clean pinned inspection workspace is
reused, but executable build/dependency state is always created from scratch.

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
- Onboarding also executes pinned Evidence Forge code after installing packages
  with lifecycle scripts disabled; use `bootstrap` when checkout-only inspection
  is required.
- `--exact-file` keeps quote bytes out of the process argument list; file paths
  remain locally visible. Compatibility `--exact TEXT` can expose the quote to
  shell history and same-host process inspection. The Kit does not repeat either
  input in progress, errors, or its final report.
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
- Read access to the three clean-history GitHub repositories; credentials are
  required only while their visibility is restricted

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
