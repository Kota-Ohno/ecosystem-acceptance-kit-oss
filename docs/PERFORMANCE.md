# Performance log

## First verified Evidence onboarding v0.6.0 — 2026-07-14

Scenario: Apple silicon / macOS / Node.js v26.0.0 / pnpm 11.0.8, warm package
cache, a new workspace and Evidence directory for every sample, wall time from
the first command until the verified packet exists. Each path was sampled three
times in alternating order.

Target: reduce the operator path from three commands to one while keeping median
time below 10 seconds and within normal network variance of the manual path.

| path | samples | median | operator commands |
| --- | --- | ---: | ---: |
| manual bootstrap + install + quickstart | 6514.6 / 6035.4 / 6073.2 ms | 6073.2 ms | 3 |
| disposable checkout with a second remote fetch (discarded) | 7593.7 / 8518.6 / 8056.2 ms | 8056.2 ms | 1 |
| final `pnpm onboard` | 7255.9 / 6325.3 / 6274.2 ms | 6325.3 ms | 1 |

The final onboarding path adds a separate packet-verification pass and complete post-run
checkout verification yet differs from the manual median by only about +4.2%,
within observed variance and well below the 10-second target. A first hardened
implementation fetched the same pinned revision from GitHub twice; it was
discarded after measuring a 32.7% median regression. The final path creates the
fresh execution checkout from the already hash-verified local object database,
so ignored build/dependency state is excluded without a second network fetch.
Checkout and package download remain the dominant work and are not skipped. The
command is retained for its two-thirds reduction in operator steps, while the
separate checkout-only bootstrap remains available when code execution is not
desired.

## Caller-source onboarding and scoped checkout — 2026-07-14

Scenario: Apple silicon / macOS / Node.js v26.0.0 / pnpm 11.0.8, warm package
cache, a new workspace and output for every sample, the same Kit README source,
exact quote, and availability time. Wall time includes checkout, dependency
installation, build, packet creation, a separate packet-verification process,
and post-run checkout verification. Three samples use each path.

Target: one operator command and below 10 seconds median. A scoped manual path is
reported separately so convenience is not confused with doing less work.

| path | samples | median | operator commands |
| --- | --- | ---: | ---: |
| scoped manual bootstrap + install + local forge | 3664 / 3464 / 3574 ms | 3574 ms | 3 |
| hardened Evidence-Forge-scoped `pnpm --silent onboard` | 4233 / 4347 / 4271 ms | 4271 ms | 1 |
| full-workspace manual path (reference only; more work) | 6040 / 5880 / 6140 ms | 6040 ms | 3 |
| first integrated path with three product checkouts (discarded) | 6910 / 6850 / 7190 ms | 6910 ms | 1 |

The alternating order was manual, onboard, onboard, manual, manual, onboard.
Each sample used a new mode-0700 temporary root. The manual harness called
`bootstrapWorkspace({ repositorySelection: ["evidenceForge"] })`, then ran these
commands in the returned checkout:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --silent forge --source "$source" --exact "$exact" \
  --available-at "$available_at" --directory "$output" --promote-immediately
```

The onboard sample ran the documented command with the same source, quote, and
timestamp. The one-command path is 19.5% slower than the scoped manual minimum:
it additionally uses a fresh disposable execution checkout, snapshots the input,
runs an independent packet verifier, validates artifact relationships, and checks
repository cleanliness. It remains under half the 10-second target while removing
two operator transitions. The earlier 36.9% reduction measures removal of two
unused product checkouts from the discarded integrated design, not an
orchestration-speed claim. Full three-product inspection remains available via
`pnpm bootstrap`.

### Private exact-file input v0.7.1

The same warm-cache Apple silicon scenario using the pinned Evidence Forge
`--exact-file` path measured 4457 / 4396 / 4342 ms (median 4396 ms, n=3). The
2.9% delta from the v0.7.0 inline-quote median remains normal checkout/package
variance; bounded private-file reads add no material latency and the result stays
below half the 10-second target.

## Installed-package development gate v0.7.2 — 2026-07-14

`pnpm check`, including syntax checks, 53 tests, tarball creation, a closed file
inventory, offline lifecycle-script-free npm install, installed help/demo, and
diagnostic-redaction smoke, completed in 2.98 seconds. The networked installed
onboarding remains an explicit release-candidate command so ordinary development
checks stay fast, deterministic, and free of repository/package-network access.

## Installed first-use and retained-verification path — 2026-07-14

Scenario: run `pnpm smoke:package:onboard` from the repository on macOS 15.4.1
arm64, Node.js 26.0.0, and pnpm 11.0.8. Every sample packs and installs the Kit
into a new temporary consumer, creates two Evidence directories through the
installed binary, then re-verifies the second packet. The global pnpm content
store is warm; the first onboarding in each sample creates its workspace and the
second reuses that exact pinned checkout. Timings use `performance.now()` around
each installed CLI process. This is a release-style installed tarball path, not a
debug build.

Target: first onboarding under 6,000 ms, repeated onboarding under 4,000 ms, and
retained verification under 4,000 ms on this machine and warm-store policy.

Baseline (three samples):

| Operation | Samples (ms) | Mean ± population SD | Range |
| --- | --- | --- | --- |
| First onboarding | 4,287; 4,102; 4,887 | 4,425 ± 335 ms | 4,102–4,887 ms |
| Repeated onboarding | 2,976; 2,957; 2,966 | 2,966 ± 8 ms | 2,957–2,976 ms |
| Retained verification | 2,835; 2,818; 2,873 | 2,842 ± 23 ms | 2,818–2,873 ms |

| # | Hypothesis | Change | Measured after | Delta | Kept? |
| --- | --- | --- | --- | --- | --- |
| 1 | Timings were invisible in installed-package smoke output. | Add non-gating per-operation measurements to the existing real smoke. | Values above; no runtime change intended. | Not applicable | Yes |

Final: all three targets are met. No runtime optimization was attempted, so no
before/after speedup is claimed and profiling stops here. The module split in
the same release is a separately justified maintainability refactor. Future
optimization work must repeat this scenario at least three times before and
after one isolated change; measurements remain informative and deliberately do
not gate CI because host and network variance are material.

Regression check: `pnpm check` and three consecutive
`pnpm smoke:package:onboard` samples passed.

## Guided Evidence entry point v0.13.0 — 2026-07-15

The installed-package smoke now exercises `ecosystem-accept evidence` rather
than calling the lower-level caller-source onboarding surface directly. A final
warm-store release-candidate run measured 4,133 ms for a new workspace, 3,027 ms
with the pinned checkout reused, and 3,274 ms for retained-packet verification.
These are single non-gating samples, not a statistical baseline; all remain
within the existing 6,000 / 4,000 / 4,000 ms targets. The guided parser,
pre-consent 64 KiB snapshot and fingerprint, human summary, and JSON routing add
no material regression relative to the preceding installed path.

The complete `pnpm check`, including 79 tests and offline packed-install smoke,
completed in 4.2 seconds on the same development machine. Networked timings
remain informational because repository and registry variance is material.
