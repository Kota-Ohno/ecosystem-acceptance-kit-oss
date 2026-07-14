# Performance log

## First verified Evidence onboarding — 2026-07-14

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
