# Contributing

Thank you for helping improve RACP.

## Before opening a pull request

1. Use Node.js 22 or newer and Python 3.12 or newer.
2. Fork and clone `https://github.com/rnby-ai/racp`.
3. Run `npm ci`.
4. Make one focused change with tests.
5. Run `npm test` and `npm run pack:check`.

Keep the public SDK independent of private RnBy application source,
credentials, tenant configuration, database migrations, and control-plane
code. Never commit tokens or production payloads.

Changes to the wire layout, intent registry, validation limits, or golden
vectors are protocol compatibility changes. Explain the compatibility impact,
update every affected implementation and vector, and include cross-language
tests.

## Pull requests

Describe the problem, the chosen behavior, tests run, and any security or
compatibility impact. Keep generated `dist/` output and package tarballs out of
the commit. By participating, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a
public issue.

## Maintainer release checklist

Publishing is deliberately ordered because workspace packages depend on one
another. Never use a bulk `npm publish --workspaces` command.

1. Confirm `main` is clean and synchronized and update `CHANGELOG.md`.
2. Confirm every package has the intended version and internal dependency
   versions.
3. Run `npm ci`, `npm test`, `npm run release:dry-run`, and
   `npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org/`.
4. Inspect every dry-run file list for credentials, absolute/local paths,
   embedded `sourcesContent`, or unexpected files.
5. Authenticate to `https://registry.npmjs.org/` with an authorized RnBy npm
   account.
6. Publish and verify one package at a time in this exact order:

   ```sh
   npm publish --workspace @rnby/racp-codec --registry=https://registry.npmjs.org/
   npm view @rnby/racp-codec@VERSION version --registry=https://registry.npmjs.org/

   npm publish --workspace @rnby/racp-client --registry=https://registry.npmjs.org/
   npm view @rnby/racp-client@VERSION version --registry=https://registry.npmjs.org/

   npm publish --workspace @rnby/racp-bridge --registry=https://registry.npmjs.org/
   npm view @rnby/racp-bridge@VERSION version --registry=https://registry.npmjs.org/

   npm publish --workspace @rnby/racp-agent --registry=https://registry.npmjs.org/
   npm view @rnby/racp-agent@VERSION version --registry=https://registry.npmjs.org/
   ```

7. Install `@rnby/racp-agent@VERSION` into a new empty directory and run a
   codec round trip from the installed package.
8. Tag the exact release commit only after all four registry checks pass.

The first release is a manual, auditable publish. A future trusted-publishing
workflow may replace the registry login, but it must preserve the same package
order, verification, and no-secret policy.
