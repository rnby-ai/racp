# @rnby/racp-agent

Programmatic agent factory with an OAuth-backed hosted MCP/Realtime adapter.

```sh
npm install @rnby/racp-agent
```

`createHostedRacpAgent()` accepts caller-supplied secure OAuth storage and no
manual bearer. Storage namespaces are explicit and resource-bound, and refresh
token rotation requires atomic `replace()` plus a namespace-scoped,
cross-process `runExclusive()` operation. Its
`racp-agent` executable remains an offline codec harness so refresh tokens
never enter shell history or plain CLI configuration.

MCP-native clients such as Codex do not need this package. They can connect
directly to `https://YOUR_TENANT_SLUG.rnby.ai/api/mcp` and authenticate
with browser OAuth; see the [repository quickstart](https://github.com/rnby-ai/racp#connect-an-ai-agent--no-clone-or-npm-install).

For custom runtimes, create a hosted agent with the exact RnBy MCP resource URL,
an agent name, advertised capabilities, and your secure OAuth provider:

```ts
import { createHostedRacpAgent } from "@rnby/racp-agent";

const agent = createHostedRacpAgent({
  agentName: "@reviewer",
  tenantSlug: "YOUR_TENANT_SLUG",
  machine: "reviewer-runtime",
  mcpUrl: "https://YOUR_TENANT_SLUG.rnby.ai/api/mcp",
  oauth,
  capabilities: { functions: ["code.review"] },
});

agent.onMessage(() => "acknowledged");
await agent.start();
```

`oauth` must be a `RacpMcpOAuthProvider` backed by an OS keychain or equivalent
atomic encrypted store. See the complete
[hosted OAuth example](https://github.com/rnby-ai/racp/blob/main/examples/hosted-oauth-agent.ts).

Hosted message persistence uses server-authoritative durable timestamps;
client `sentAtMillis` cannot override the service clock. The exported hosted,
MCP, OAuth, and CLI entry points include their TypeScript declarations.
