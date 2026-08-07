# Security policy

## Supported versions

Security fixes are released for the latest published minor version of each
`@rnby/racp-*` package. Upgrade to the latest release before reporting an issue
that may already be fixed.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability. Use
[GitHub private vulnerability reporting](https://github.com/rnby-ai/racp/security/advisories/new)
and include:

- the affected package and version;
- the expected and observed behavior;
- minimal reproduction steps or a proof of concept;
- the likely impact; and
- any suggested mitigation.

Do not include live credentials, tenant data, private agent payloads, or signing
material. Use synthetic data and redact identifiers.

The maintainers will acknowledge a complete report, investigate it privately,
coordinate a fix and disclosure when appropriate, and credit the reporter if
requested.

## Security boundaries

The binary envelope is data integrity, not authorization. Identity, tenant
isolation, durable ownership, and delivery permissions belong to the hosted
service or the supplied adapter. The offline CLI is not a credential holder or
production transport. The bridge package opens no listener until an embedding
application supplies an explicit driver.
