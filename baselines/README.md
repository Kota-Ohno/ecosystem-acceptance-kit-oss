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

`v0.4.2.lock.json` preserves the last clean-history pins before final review
remediation. The v0.4.2→v0.4.3 preflight records the resulting product and
schema classification; its manual-review decision is backed by the subsequent
full acceptance entry rather than treated as semantic proof by itself.

`v0.4.3.lock.json` preserves the reviewed ecosystem pins before the final Agent
Black Box writer hardening. The v0.4.3→v0.4.4 preflight records that product-only
change; the subsequent full acceptance entry supplies the interoperability proof.

`v0.4.4.lock.json` preserves the final reviewed branch heads before private-main
integration. The v0.4.4→v0.4.5 preflight records the merge-revision transition;
the subsequent full acceptance entry verifies those exact integrated commits.

`v0.4.5.lock.json` preserves the integrated hardening baseline before the
one-command onboarding and documentation update. The v0.4.5→v0.5.0 preflight
records the product and documentation changes; the subsequent full acceptance
entry verifies the exact merged onboarding commits.

`v0.5.0.lock.json` preserves the onboarding baseline before the measured
Evidence Forge quickstart optimization. The v0.5.0→v0.5.1 preflight records the
product-only build-path change; the subsequent full acceptance entry verifies
the exact merged optimization commit.

`v0.6.0.lock.json` preserves the one-command tutorial onboarding baseline before
the real local-file forge workflow. The v0.6.0→v0.6.1 preflight records the
product, documentation, and performance-evidence change; the subsequent full
acceptance entry verifies the exact merged implementation commit.

`v0.12.0.lock.json` preserves the final onboarding and retained-verification
baseline before the three product roadmaps recorded clean-history acceptance.
The v0.12.0→v0.12.1 preflight classifies those documentation-only heads; the
subsequent full acceptance entry verifies their exact integrated revisions.

`acceptance-index.json` is an append-only summary of locally verified acceptance
receipts. Each entry binds its prior entry, exact revisions, receipt head, and
artifact heads. Git history provides a separate retained copy of the index head,
but neither Git nor this file supplies a trusted timestamp, signer identity, or
the original receipt and release-pack bytes. Reverify those source artifacts
when their full assurances are required.
