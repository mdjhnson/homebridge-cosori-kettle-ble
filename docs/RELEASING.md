# Releasing

Releases go to npm as `homebridge-cosori-kettle-ble`. Publishing a GitHub release runs `.github/workflows/release.yml`. It checks the version, runs lint, typecheck, build and tests, and **stages** the package on npm through trusted publishing (OIDC, no token in the repo). A staged version goes live only after the maintainer approves it with 2FA, so a compromised workflow can't publish on its own.

- **Pre-releases** (`0.2.0-beta.1`): a GitHub release marked *pre-release*, published under the npm dist-tag `next`.
- **Stable** (`0.2.0`): a normal GitHub release, published under `latest`.
- **Until the first stable version, `latest` has to be moved by hand.** npm pointed `latest` at the first version (`0.2.0-beta.1`), and a pre-release published under `next` doesn't move it. So each pre-release gets a `npm dist-tag add` step after approval (step 5 below). Without it, `npm install homebridge-cosori-kettle-ble` and the Homebridge UI keep serving the old beta.
- The workflow refuses a release whose tag isn't `v` + the `package.json` version, or whose pre-release checkbox doesn't match the version. It skips a version that is already on npm.

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
6. **Check the dist-tags** with `npm dist-tag ls homebridge-cosori-kettle-ble`. npm points `latest` at the very first version, even one published with `--tag next`. It did for `0.2.0-beta.1`. That's why "Each release" moves `latest` by hand until the first stable version.

## Each release

1. **Version bump, on a branch and PR.** `npm version <new-version> --no-git-tag-version`, then add a section to `CHANGELOG.md` with the release date. Merge the PR once CI passes.
2. **GitHub release**, from an up-to-date `main`. Leave out `--prerelease` for a stable version:
   ```sh
   gh release create v<new-version> --target main --prerelease --title "<new-version>" --notes-file <(awk '/^## /{p=($2=="<new-version>")} p' CHANGELOG.md | sed 1d)
   ```
3. **Watch the workflow:** `gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')"`.
4. **Approve** with 2FA. A session from `npm login` lasts about 2 hours, so log in when the workflow has finished, not before cutting the release. If `npm whoami` fails, run `npm login` first. Then: `npm stage list homebridge-cosori-kettle-ble`, then `npm stage approve <stage-id>`. Or use the package's *Staged Packages* tab on npmjs.com. Reject a bad one with `npm stage reject <stage-id>`.
5. **Pre-releases only, while no stable version exists: move `latest`** to the new version, so plain installs and the Homebridge UI get it (npm asks for 2FA). Skip this step once a stable version is on `latest`: from then on, betas stay on `next` only.
   ```sh
   npm dist-tag add homebridge-cosori-kettle-ble@<new-version> latest && npm dist-tag ls homebridge-cosori-kettle-ble
   ```
6. **Deploy to the Pi.** Back up `config.json` first. Install the exact version, then restart **only the Kettle child bridge**:
   ```sh
   docker exec homebridge npm install --prefix /homebridge homebridge-cosori-kettle-ble@<new-version>
   ```

A branch can still be tested on the Pi before a release with a tarball (`npm pack`; see README "Install").
