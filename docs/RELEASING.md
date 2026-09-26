# Releasing

Releases go to npm as `homebridge-cosori-kettle-ble`, built and staged by GitHub Actions through trusted publishing (OIDC, no token in the repo). A staged version goes live only after the maintainer approves it with 2FA, so a compromised workflow can't publish on its own.

## Each release (from the browser)

1. **Actions → Prepare release → Run workflow.** Leave *Version* empty for the next beta (`0.3.0-beta.2` → `0.3.0-beta.3`), or type one (`0.4.0-beta.1`, `1.0.0`). Tick *Dry run* to only see the changes. The workflow bumps `package.json` and `package-lock.json`, turns the `## Unreleased` notes in `CHANGELOG.md` into the new version's section (or uses GitHub's generated notes, the merged PRs, if there are none), and pushes the branch `release/v<version>`.
2. **Open the pull request** from the link in the run's summary (the title and description are filled in), click *Create pull request*, and **merge** it once CI passes. `main` only takes changes through pull requests, which is why the workflow stops at a branch.
3. **The merge runs the Release workflow** (`.github/workflows/release.yml`). It runs lint, typecheck, build and tests, **stages** the version on npm, then creates the tag `v<version>` and the GitHub release with the CHANGELOG section as notes.
4. **Approve** the staged version with 2FA on npmjs.com: the package → *Staged Packages* tab. (Or in a terminal: `npm login`, `npm stage list homebridge-cosori-kettle-ble`, then `npm stage approve <stage-id>`.) Reject a bad one there, or with `npm stage reject <stage-id>`.
5. **Deploy to the Pi.** Back up `config.json` first. Install the exact version, then restart **only the Kettle child bridge**:
   ```sh
   docker exec homebridge npm install --prefix /homebridge homebridge-cosori-kettle-ble@<version>
   ```

**Dist-tags:** a stable version goes to `latest`. A pre-release goes to `next`, except while npm has no stable version: then it goes to `latest` too, so plain installs and the Homebridge UI get the newest beta without a manual `npm dist-tag` step. (Until `0.3.0-beta.2`, betas went to `next` and `latest` was moved by hand, so `next` stops following new betas until the first stable version.)

**Checks the workflow makes:** Prepare release refuses a version that is already on `main`, tagged, on npm, or has a `release/v…` branch. The Release workflow skips a push that changes `package.json` without a new version (a dependency update), and skips staging a version that is already on npm (it still creates a missing GitHub release).

**Retry:** if the Release workflow fails after the merge (npm down, say), fix the cause and run it by hand: Actions → Release → Run workflow, on `main`.

**A version bump made by hand** (a PR with `npm version <version> --no-git-tag-version` and a CHANGELOG section) is released the same way: merging it runs the Release workflow. Don't also publish a GitHub release for it. Publishing a GitHub release by hand still triggers the workflow (the tag must be `v` + the `package.json` version, and *Set as a pre-release* must match), but that's only needed for a version on `main` that was never released.

A branch can still be tested on the Pi before a release with a tarball (`npm pack`; see README "Install").

## One-time setup

**Done 2026-09-25** with `0.2.0-beta.1`. Kept for reference, e.g. if the trusted publisher ever has to be recreated.

npm can only attach a trusted publisher to a package that already exists, so the first version is published by hand.

1. **npm account.** Create one at npmjs.com with 2FA on, then log in on the Mac: `npm login`.
2. **First publish, from the Mac.** Start from a clean, up-to-date `main` with `package.json` at the first version (`0.2.0-beta.1`). `prepublishOnly` runs lint, build and test. `--provenance=false` is needed because provenance only works from CI. npm asks for 2FA.
   ```sh
   cd ~/GitHub/mdjhnson/homebridge_kettle && git checkout main && git pull --ff-only && test -z "$(git status --porcelain)" && npm ci && npm run typecheck && npm publish --tag next --provenance=false
   ```
3. **Trusted publisher.** This lets `release.yml` stage versions:
   ```sh
   npm trust github homebridge-cosori-kettle-ble --repo mdjhnson/homebridge-cosori-kettle-ble --file release.yml --allow-stage-publish && npm trust list homebridge-cosori-kettle-ble
   ```
   Or on npmjs.com: the package → *Settings* → *Trusted publisher* → GitHub Actions, with owner `mdjhnson`, repository `homebridge-cosori-kettle-ble`, workflow `release.yml`, and staged publishing allowed.
4. **Lock it down.** On npmjs.com: the package → *Settings* → *Publishing access* → **Require two-factor authentication and disallow tokens**.
5. **The GitHub release for the first version.** It holds the release notes. The workflow runs `npm view` to see that the version is on npm and skips it. Right after the first publish, `npm view` can return 404 for a minute or so while the registry's cache still holds the earlier "not found". The workflow would then try to stage a version that already exists and fail. So wait until `npm view` succeeds before creating the release:
   ```sh
   until npm view homebridge-cosori-kettle-ble@0.2.0-beta.1 version; do sleep 10; done && gh release create v0.2.0-beta.1 --target main --prerelease --title "0.2.0-beta.1" --notes-file <(awk '/^## /{p=($2=="0.2.0-beta.1")} p' CHANGELOG.md | sed 1d)
   ```
6. **Check the dist-tags** with `npm dist-tag ls homebridge-cosori-kettle-ble`. npm points `latest` at the very first version, even one published with `--tag next`. It did for `0.2.0-beta.1`. That's why `latest` was moved by hand after each beta up to `0.3.0-beta.2`; the Release workflow now stages betas under `latest` itself while there's no stable version.
