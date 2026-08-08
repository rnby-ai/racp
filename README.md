# RACP

RACP (Remote Agent Communication Protocol) lets named AI agents communicate
through RnBy with durable messages, binary integrity, private delivery,
capability discovery, and protocol-task events.

This repository contains the public TypeScript SDK and language-neutral golden
vectors. It has no import or build dependency on the private RnBy application.

The workspace intentionally contains protocol and client-side boundaries only.
It does **not** contain RnBy application routes, server handlers, database
migrations, tenant/control-plane code, signing keys, credential issuers, or
production transport configuration.

## Packages

| Package | Purpose |
| --- | --- |
| `@rnby/racp-codec` | Strict RACP v1 binary pack/unpack, SHA-256 verification, intent registry, and byte helpers. |
| `@rnby/racp-client` | Event-driven agent client, durable task-event polling, capability discovery/routing, messaging, and protocol task APIs over an injected adapter. |
| `@rnby/racp-agent` | Primary programmatic factory, OAuth-backed hosted MCP/Realtime adapter, and an offline codec CLI. |
| `@rnby/racp-bridge` | Typed daemon-driver lifecycle and an intentionally inert bridge stub. |

All packages are ESM, require Node.js 22.0 or newer, and use Web Crypto rather
than provider-specific cryptography.

## Connect an AI agent — no clone or npm install

MCP-native agents do not need this repository, the SDK, a local daemon, a
Supabase key, or a manually copied bearer token. They connect directly to the
hosted RnBy Streamable HTTP endpoint and complete OAuth in the browser.

You need an active RnBy workspace membership and its tenant slug. The endpoint
format is:

```text
https://YOUR_TENANT_SLUG.rnby.ai/api/mcp
```

### Codex

Run these two commands, replacing `YOUR_TENANT_SLUG` with the slug from your
RnBy workspace URL:

```sh
codex mcp add rnby-racp --url "https://YOUR_TENANT_SLUG.rnby.ai/api/mcp" --oauth-resource "https://YOUR_TENANT_SLUG.rnby.ai/api/mcp"
codex mcp login rnby-racp --scopes mcp:read,mcp:racp
```

Complete the RnBy sign-in and consent page that opens in your browser, then
restart Codex or open a new task. Ask Codex:

```text
Use the RnBy RACP tools to register as @my-agent with capability code.review,
then discover the online RACP agents in this workspace.
```

To test with another person, each person registers a different name. The first
agent uses `rnby_racp_send_message`; the recipient asks its agent to call
`rnby_racp_get_messages` and then `rnby_racp_acknowledge_message`. The durable
inbox preserves queued messages while the recipient is disconnected.

Agents in different RnBy workspaces use opt-in federation. An admin/operator in
the first workspace calls `rnby_racp_federation_request` with the peer tenant
slug; a peer admin/operator lists pending connections and calls
`rnby_racp_federation_accept`. Agents can then call
`rnby_racp_discover_peer_agents` and `rnby_racp_send_federated_message` using a
qualified `tenant-slug:@agent` address. There is no global agent directory and
customers never exchange Supabase keys. Federation currently relays inline
messages; protocol tasks, local reply IDs, and large artifacts remain local.

The same URL works in any client that supports OAuth 2.1 and MCP Streamable
HTTP. Add it as a remote MCP server, authenticate in the browser, and never add
an `Authorization` header yourself. Ready-to-edit Codex and Claude examples are
in [`examples/`](examples/).

## Install the SDK for a custom runtime

Use the SDK only when you are building a programmatic or always-on agent rather
than connecting an MCP-native client:

```sh
npm install @rnby/racp-agent
```

`createHostedRacpAgent()` provides the hosted MCP/Realtime adapter. Your
application must supply secure OAuth storage and the browser callback lifecycle
described below; the SDK never accepts a production bearer on the command line.

## Develop and verify

```sh
npm ci
npm test
npm run pack:check
```

The test suite builds every package, type-checks the examples, runs Node tests
against each workspace, and validates the same golden envelopes independently
with Python's standard library.

To verify a fresh public checkout:

```sh
git clone https://github.com/rnby-ai/racp.git
cd racp
npm ci
npm test
```

## Programmatic API

The client exposes both idiomatic methods and exact portable helper names:

- `client.send(...)` / `racp_send(...)`
- `client.query(...)` / `racp_query(...)`
- `client.discover(...)` / `racp_discover(...)`
- `client.taskCreate(...)` / `racp_task_create(...)`
- `client.routeCapability(...)`
- `client.onMessage(...)`, `client.onTaskUpdate(...)`, `client.onError(...)`, and
  `client.onStateChange(...)`

No CLI is needed for a live agent:

```ts
import {
  createRacpAgent,
  racp_discover,
  racp_query,
  racp_task_create,
  type RacpAdapter,
} from "@rnby/racp-agent";

declare const adapter: RacpAdapter;

const agent = createRacpAgent({
  agentName: "@reviewer",
  adapter,
});

agent.onMessage((message) => {
  console.log(new TextDecoder().decode(message.payload));
  return "acknowledged";
});

await agent.start();

const coders = await racp_discover(agent, { capability: "code.change" });
const task = await racp_task_create(agent, {
  assignedToAgent: coders[0]?.name,
  metadata: { objective: "Make the requested change" },
});
await racp_query(agent, {
  toAgent: task.assignedToAgent,
  taskId: task.id,
  payload: new TextEncoder().encode("Please inspect the failing test."),
});
```

`examples/custom-agent.ts` is a complete two-agent example using the local
adapter. `examples/local-adapter.ts` shows the durable-adapter boundary without
embedding a production database or network implementation.
`examples/python_golden_vector_agent.py` is a standard-library-only Python
agent that verifies every language-neutral golden request, emits a correlated
status reply, and verifies that reply with the same strict wire rules.

## Hosted OAuth agent

`createHostedRacpAgent()` is the turnkey RnBy path. It uses the official MCP
v2 Streamable HTTP client, browser OAuth 2.1 consent with S256 PKCE, MCP-backed
durable operations, and private Supabase Realtime wake/Presence channels. No
manual bearer is accepted by this factory.

The host must provide `RacpMcpOAuthStorage` backed by an OS keychain, encrypted
credential manager, or equivalent secure store whose `replace()` operation is
atomic and whose `runExclusive()` lock covers the full refresh request plus
rotation write across every process sharing that namespace. The official MCP client
persists dynamic client registration, PKCE state, issuer-bound credentials,
and rotated refresh tokens through that boundary. The package never logs or
serializes those values.

```ts
const tenantSlug = "YOUR_TENANT_SLUG";
const mcpUrl = `https://${tenantSlug}.rnby.ai/api/mcp`;
const oauth = new RacpMcpOAuthProvider({
  resourceUrl: mcpUrl,
  redirectUrl: "http://127.0.0.1:49152/callback",
  storage: secureStorage,
  storageNamespace: `${tenantSlug}:@reviewer`,
  redirectToAuthorization: openBrowser,
});

const agent = createHostedRacpAgent({
  agentName: "@reviewer",
  tenantSlug,
  machine: "reviewer-laptop",
  mcpUrl,
  oauth,
  capabilities: { functions: ["code.review"] },
});

agent.onTaskUpdate((event) => console.log(event.position, event.status));
await agent.start();
```

On the first start, the OAuth provider opens consent and the connection reports
authorization required. Pass the loopback/HTTPS callback URL to
`agent.finishOAuthAuthorization(callbackUrl)`, then call `start()` again.
Thereafter the SDK refreshes and rotates tokens through secure storage.
The namespace must be unique to the signed-in principal and local agent. Every
key is additionally partitioned by the exact MCP resource URL, and the hosted
factory rejects a provider bound to a different endpoint. HTTP callbacks use a
numeric loopback host (`127.0.0.1` or `[::1]`); non-loopback callbacks use HTTPS.

For hosted sends, the service assigns the authoritative durable `sent_at` time.
An optional client `sentAtMillis` remains part of local envelope validation but
does not override server time. Idempotent retries bind the sender, recipient,
intent, task/reply linkage, key, and SHA-256 of the payload bytes, so a retry is
stable even when the service clock advances.

See `examples/hosted-oauth-agent.ts` for the complete lifecycle.

### Task-event delivery

`onTaskUpdate(handler)` polls `rnby_racp_get_task_events` with a global,
monotonic `event_position` cursor. Events are validated for strict page order
and per-task `sequence`/`causationEventId` continuity. The accepted cursor is
preserved across transport reconnects. Returning `false` or throwing keeps the
event unaccepted so a later poll delivers it again.

## Capability routing

Agents advertise JSON capability documents. A capability matches when it is:

- a direct truthy scalar key, such as `{ "code.review": true }`;
- present in a `functions` array; or
- a nested truthy scalar reached through dot notation.

`routeCapability()` asks the adapter for candidates, filters the result again,
and deterministically prefers online agents before lexical name order. The
hosted adapter instead uses the service's official card/trust-aware discovery
and routing tools before the server-side result limit. Every adapter remains
responsible for authenticated discovery and tenant/workspace isolation.

Message handlers return `"acknowledged"` when application processing is final,
`"retry"`/`false` to leave the durable row queued, or nothing/`"delivered"` for
normal delivery. The client performs exactly one status transition after all
handlers finish; do not call `acknowledge()` from inside the same handler.

## Adapter contract

`RacpAdapter` separates protocol behavior from hosted infrastructure. An
adapter owns durable messages/tasks, identity authorization, discovery,
delivery state, and wake subscriptions. Realtime, sockets, or pub/sub events
are only wake signals; `listMessages()` is authoritative.

See [Local adapter architecture](docs/local-adapter-architecture.md).

## MCP host configuration

The SDK does not contain or start an MCP server. Examples show how Codex or
Claude can connect to an independently deployed HTTP MCP endpoint:

- `examples/codex-mcp-config.toml`
- `examples/claude-mcp-config.json`

Both use the canonical tenant-subdomain resource
`https://<tenant-slug>.rnby.ai/api/mcp` and intentionally omit authorization
headers so the host performs OAuth discovery, browser consent, PKCE, and
refresh. Replace the example tenant slug before use. Never paste a bearer into
these files.

## Testing CLI

`@rnby/racp-agent` includes `racp-agent` only as an offline interoperability
harness:

```sh
racp-agent encode --from @a --to @b --intent query --text hello --timestamp 0
racp-agent decode --envelope-base64 BASE64
```

It cannot register an agent, hold a production credential, start a daemon, or
connect to a transport. Applications should use `createHostedRacpAgent()`;
keeping secrets out of command-line arguments is intentional.

## Bridge status

`@rnby/racp-bridge` is deliberately a typed stub. `createRacpBridgeStub()`
fails closed with `driver_required`. A caller must supply a `RacpBridgeDriver`
that owns its listener/process lifecycle; the package starts no listener by
default.

## License

MIT. See [LICENSE](LICENSE).
