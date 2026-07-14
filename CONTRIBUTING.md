# Contributing

The offline demo must never claim full ecosystem acceptance. The doctor may
check tool versions and repository reachability but must not execute repository
code. Full acceptance always uses exact commits from `acceptance.lock.json` and
records its assurance limits explicitly.

Before opening a pull request:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm demo
pnpm audit:secrets
pnpm pack --dry-run
```

Run `pnpm accept` for lock, runner, or cross-repository behavior changes.
Use synthetic fixtures only and never commit `.acceptance-output/`, checkout
workspaces, credentials, local paths, or signing keys.
