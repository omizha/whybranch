# Releasing

The public source repository is [omizha/whybranch](https://github.com/omizha/whybranch).
GitHub source publication and npm package publication are separate steps. A
GitHub push or passing checks does not authorize an npm publish.

## Repository setup

1. Keep the `repository`, `bugs`, and `homepage` fields in `package.json`
   aligned with the public source repository.
2. Enable GitHub's **Private vulnerability reporting** and verify the
   [private reporting route](https://github.com/omizha/whybranch/security/advisories/new)
   documented in [SECURITY.md](SECURITY.md).
3. Review the Node 20/22 CI results and configure branch protection before
   accepting outside contributions.

## Before the first npm release

Check npm name availability and ownership using the account that will own the
package. Do not assume the current package name is available. Publication
requires explicit authorization for the target registry and access level.

## Per-release checklist

1. Update [CHANGELOG.md](CHANGELOG.md) and the package version. Update
   [README.ko.md](README.ko.md) first when the documented behavior changes, then
   synchronize [README.md](README.md) as its English translation.
2. From a clean checkout, run:

   ```sh
   npm ci --ignore-scripts
   npm test
   npm run lint
   npm run check
   npm run pack:dry-run
   ```

3. Inspect the generated tarball file list. It must contain the binary, core,
   examples, both READMEs, linked documentation, and shared integration assets—never local
   workspace state, seed files, secrets, or `node_modules`.
4. Publish only after the maintainer explicitly authorizes the target registry
   and access level. Tag the same reviewed commit after a successful publish.

No release step is performed automatically by this repository.
