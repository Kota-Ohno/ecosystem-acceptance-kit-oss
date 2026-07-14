# Retained baselines

Versioned lock files preserve the inputs accepted by each kit release. The
current [`acceptance.lock.json`](../acceptance.lock.json) remains the default.

`v0.3.1.lock.json` preserves the last pre-public-readiness baseline and
`v0.3.1-to-v0.3.2.preflight.json` records the non-executing path classification
for the three merged hygiene updates. Preflight classification does not replace
the full acceptance entry retained in the index.

`v0.3.2.lock.json` preserves the final private-history default before the
clean-history `-oss` relocation. The corresponding v0.3.2→v0.4.0 preflight is
retained separately because relocation requires explicit manual review.

`acceptance-index.json` is an append-only summary of locally verified acceptance
receipts. Each entry binds its prior entry, exact revisions, receipt head, and
artifact heads. Git history provides a separate retained copy of the index head,
but neither Git nor this file supplies a trusted timestamp, signer identity, or
the original receipt and release-pack bytes. Reverify those source artifacts
when their full assurances are required.
