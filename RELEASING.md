# Releasing

This checkout is deliberately **not publish-ready until ownership is chosen**.
Do not publish an npm package or push a public remote just because the local
checks pass.

## One-time ownership setup

1. Create the real public Git repository and set the `repository`, `bugs`, and
   `homepage` fields in `package.json`; replace every `OWNER` placeholder.
2. Configure a private vulnerability-reporting route and update
   [SECURITY.md](SECURITY.md) with the real contact path.
3. Check npm name availability and ownership using the account that will own
   the package. Do not assume the current package name is available.
4. Configure branch protection and require the Node 20/22 CI workflow.

## Per-release checklist

1. Update [CHANGELOG.md](CHANGELOG.md) and the package version.
2. From a clean checkout, run:

   ```sh
   npm ci --ignore-scripts
   npm test
   npm run lint
   npm run check
   npm run pack:dry-run
   ```

3. Inspect the generated tarball file list. It must contain the binary, core,
   examples, linked documentation, and shared integration assets—never local
   workspace state, seed files, secrets, or `node_modules`.
4. Publish only after the maintainer explicitly authorizes the target registry
   and access level. Tag the same reviewed commit after a successful publish.

No release step is performed automatically by this repository.
