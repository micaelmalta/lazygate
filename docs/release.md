# Releasing lazygate

lazygate ships as the npm package `lazygate` (`bin: lazygate`). The tarball contains `dist/`,
`config/` (examples), `scripts/` (migrate, revert, session-sync, benchmark and their fixtures) and
`docs/`. Sources, tests, source maps and local files are left out; `npm run pack:check` enforces it.

## Before tagging

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run pack:check        # lists what would be published and fails on missing or leaked files
npm run benchmark:ci      # quick suite against benchmarks/baseline.json
```

If the benchmark gate reports an intended change (fewer tokens, better discovery), run
`npm run benchmark:baseline`, review the diff of `benchmarks/baseline.json`, and commit it with the
change. To refresh the published full results:

```bash
node dist/index.js benchmark --suite --out-dir benchmarks/results   # 15 rounds; takes ~10+ minutes
```

Then update the numbers in the "What the published run shows" list in `docs/reference.md`.

## Publishing

1. Bump `version` in `package.json` and commit.
2. Tag and push: `git tag v1.2.3 && git push origin main --tags`.
3. `.github/workflows/release.yml` checks that the tag matches `package.json`, runs typecheck, tests,
   the package check and the benchmark gate, then runs `npm publish --provenance --access public`.
   It needs an `NPM_TOKEN` repository secret (an npm automation token). The package is MIT
   licensed (`LICENSE`, and `license` in `package.json`); `npm run pack:check` fails if `LICENSE`
   is missing from the tarball.

Publishing by hand works too: `npm publish --access public` (`prepublishOnly` builds and runs the
package check; `prepack` rebuilds `dist/` from scratch).

## Checking an install

```bash
npm pack                                   # produces lazygate-<version>.tgz
npm install -g ./lazygate-<version>.tgz    # or: npm install -g lazygate once published
lazygate migrate --from claude --dry-run
```

The package requires Node.js 22 or later (`engines`).
