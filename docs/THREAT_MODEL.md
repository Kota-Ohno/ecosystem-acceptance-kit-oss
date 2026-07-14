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
