# Releasing

Releases are tag-driven. A tag such as `v0.5.0` runs the full release gate,
publishes the public npm package through OIDC trusted publishing, and then
creates the matching GitHub Release.

## One-time npm configuration

In the `ai-config-sync` package settings on npmjs.com, add a GitHub Actions
trusted publisher with these exact values:

- Organization or user: `Super-YYQ`
- Repository: `ai-config-sync`
- Workflow filename: `release.yml`
- Environment: `npm`
- Allowed action: `npm publish`

Create the matching `npm` GitHub environment and add any desired deployment
approval rules. No long-lived npm publish token is used by the workflow.

## Release procedure

1. Run `npm run version:set -- X.Y.Z`.
2. Replace the Unreleased changelog heading with `X.Y.Z` and finish the notes.
3. Run `npm run release:tag-check -- vX.Y.Z` and `npm run release:check`.
4. Commit and push the version changes; wait for `CI` to pass on `main`.
5. Create and push the exact tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
6. Verify the `Release` workflow, npm provenance, and generated GitHub Release.

The workflow rejects a tag that does not exactly match `package.json`, plugin
manifests, or the changelog release heading.
