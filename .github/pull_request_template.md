## Summary

Describe the operator-visible outcome and assurance boundary.

## Verification

- [ ] `npm run check`
- [ ] `npm run demo`
- [ ] `npm run audit:secrets`
- [ ] `npm run accept` for lock, runner, or cross-repository changes

## Acceptance and release boundary

- [ ] Synthetic demo output does not claim full acceptance
- [ ] Diagnostics do not execute repository code or expose access errors
- [ ] No credentials, local paths, acceptance outputs, or private keys were added
- [ ] This PR does not make anything public or publish a package
