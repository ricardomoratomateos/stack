# Releasing Foreman

A release is a git tag. Everything else — tests, the `.vsix`, the GitHub
release, the marketplaces — is done by `.github/workflows/release.yml` when the
tag lands.

## Cutting one

1. Move what is under `## [Unreleased]` in `CHANGELOG.md` to a new
   `## [x.y.z] — YYYY-MM-DD` section and add its link at the bottom. The
   workflow turns that section into the release notes, and fails if it is missing.
2. Bump and tag in one go:

   ```sh
   npm version minor   # or patch, or an explicit x.y.z
   ```

   `preversion` runs the type check and the test suite with its 100% coverage
   gate first, so a red tree cannot be tagged. `npm version` then commits
   `package.json` + `package-lock.json` and creates the `vx.y.z` tag.
3. Push, tags included:

   ```sh
   git push --follow-tags
   ```

Watch it under Actions → Release. When it is green, the release is on the
repository's Releases page with the `.vsix` attached, and — if the tokens below
exist — on both marketplaces a few minutes later.

## Where it publishes

| Where | Who uses it | Secret | How to get the token |
|---|---|---|---|
| GitHub Releases | manual installs (`code --install-extension foreman-x.y.z.vsix`) | none | — |
| [VS Code Marketplace](https://marketplace.visualstudio.com/manage) | VS Code | `VSCE_PAT` | Azure DevOps → Personal Access Token, scope *Marketplace → Manage*, all organizations. The `foreman` publisher must exist first. |
| [Open VSX](https://open-vsx.org) | Cursor, Windsurf, VSCodium, code-server, Gitpod, Theia | `OVSX_PAT` | open-vsx.org → sign the publisher agreement → Access Tokens. Create the namespace once: `npx ovsx create-namespace foreman -p <token>`. |

Both publish steps are skipped, not failed, while their secret is absent.
Add them under Settings → Secrets and variables → Actions.

## By hand, if ever needed

```sh
npm run package                                        # foreman-x.y.z.vsix
npx vsce publish --no-dependencies --packagePath foreman-x.y.z.vsix -p "$VSCE_PAT"
npx ovsx publish foreman-x.y.z.vsix -p "$OVSX_PAT"
```

A pre-release version (`1.2.0-beta.1`) is marked as such on GitHub.
