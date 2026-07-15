# Threat model

## Trust boundary

The lock file selects executable source commits. The runner limits repository
locations to uncredentialed `https://github.com/...` URLs and requires full
lowercase commit SHAs, but it does not establish that a commit is benign or
authored by a particular party. Operators must review lock changes.

`pnpm`, npm compatibility consumers, Cargo, and the pinned repositories run with the current user's
permissions and may access the network. Repository checks receive a reduced environment with an
isolated `HOME` and temporary directory, and every dependency install disables lifecycle scripts.
This reduces accidental credential inheritance but does not prevent repository code from reading
host files or using the network. The kit is orchestration, not a sandbox.

Caller-source onboarding opens the selected regular file without following a
symlink and fixes its bytes in a private temporary snapshot before checkout or
installation. It passes that snapshot path and the exact quote to the pinned
Evidence Forge child as arguments. They are not copied into Kit progress, errors,
or its final report, but the quote may remain visible to local shell history or
same-host process inspection. The resulting private Evidence directory retains
the source snapshot and citation by design. The Kit re-checks the output-parent
identity immediately before execution and removes its temporary input snapshot.
Immediate promotion is
preauthorized; this mode does not represent human inspection of the Candidate.
The human-facing `evidence SOURCE` command performs this bounded validation and
private snapshot before prompting, displays the fixed snapshot's SHA-256, and
passes only that fixed file into onboarding. Consent therefore remains bound to
the same bytes even if the original path changes while the questions are open.
The pre-consent snapshot is removed on cancellation, success, failure, or a
handled process-exit signal.

With `--cite-entire-source`, the same private snapshot path is supplied as both
source and exact-file input, so no source bytes are copied into process arguments
and there is no separately prepared quote file. The Kit validates the pinned
exact-file byte contract before bootstrap and registers snapshot cleanup before
bootstrap can start a child process. It does not claim that the snapshot is
immutable against pinned repository code running as the same user; that code
could alter a mode-0600 file between its own reads because onboarding is not a
sandbox.

Retained-Evidence verification requires the expected packet SHA-256 as a command
argument rather than automatically trusting a digest stored beside the packet.
The Kit cannot determine whether the caller stored that argument independently.
It checks the private Evidence directory and packet identities, fixes the packet bytes in
a private temporary snapshot, then invokes a fresh checkout of the pinned
Evidence Forge verifier. Signal cleanup is registered before bootstrap, and the
retained Evidence directory is read-only from the Kit's workflow. As elsewhere,
same-user pinned code is inside the trust boundary and is not sandboxed.

## Fail-closed properties

- Moving branches and tags are not accepted as revisions.
- Every detached checkout must resolve to the requested commit and start clean.
- The current Sol Ledger implementation and consumer-pinned wire contract are
  fetched and checked as separate immutable revisions.
- Agent Black Box compatibility is executed against the exact consumer-pinned
  wire-contract checkout, so its own embedded pin cannot silently diverge.
- A failed prerequisite, product check, compatibility check, or packed acceptance
  stops the run and produces a sealed failure receipt.
- Successful receipts are created only after expected packed artifacts exist and
  their SHA-256 digests have been computed.
- Receipt files are exclusive-created with mode `0600`; result directories use
  mode `0700`.
- Ephemeral signing private keys created by packed acceptance are deleted after
  all signature and release-pack verification completes.
- Output and disposable-workspace roots must be disjoint, preventing cleanup
  from traversing into retained acceptance artifacts.
- Workspace and output paths are redacted from streamed child output and errors.
- Child commands have bounded runtimes and timeout cleanup targets their process
  groups before escalating to a forced kill.
- Onboarding checks out only the pinned Evidence Forge revision it executes;
  the default `bootstrap` and full acceptance paths continue to cover all three
  product revisions.

## Non-claims

A verified receipt demonstrates one local run over three exact revisions. It
does not provide process isolation, malware analysis, commit authorship,
reproducible-build proof, a trusted timestamp, or independent storage of the
receipt head. The packed Evidence Forge flow provides its own signature and
artifact checks; the outer receipt records those results without replacing them.

Upgrade preflight fetches exact commits and lists changed paths without checking
out or executing repository code. Path classification is intentionally
conservative and cannot prove semantic compatibility. Contract, schema, and
repository-location changes require manual review, and every changed lock still
requires a complete acceptance run.

The retained index requires expected receipt and previous-index heads as command
arguments, rejects duplicates, and writes a new private file for every append.
This makes silent local mutation detectable when anchors are stored separately.
The tool cannot determine whether an operator actually obtained an expected head
through an independent channel, and it provides neither signer identity nor a
trusted timestamp.
