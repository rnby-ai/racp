# Local adapter architecture

The public client treats every storage or network implementation as an
untrusted boundary. A conforming adapter implements `RacpAdapter` and keeps
these responsibilities outside the codec and client packages.

```text
application agent
  -> @rnby/racp-client (lifecycle, events, routing, delivery semantics)
    -> RacpAdapter (authorization + durable operations)
      -> durable message/task store
      -> optional wake transport (socket, pub/sub, Realtime, IPC)
```

The included `RacpHostedAdapter` is the production-shaped implementation:

```text
RacpHostedAgent
  -> official MCP v2 Streamable HTTP client (OAuth member authority)
    -> durable agent/message/task/task-event tools
  -> short-lived Data credential (Presence lease RPC only)
  -> distinct short-lived Realtime credential
    -> exact private inbox wake + Presence topics
```

Realtime frames never become messages directly. They only wake an MCP-backed
durable inbox drain, where the binary envelope is decoded and verified again.

## Required invariants

1. Bind every operation to one authenticated workspace and agent identity.
2. Treat the compact envelope as data, not authorization.
3. Persist normalized routing, idempotency, task, reply, and delivery fields
   beside the envelope.
4. Make `(workspace, sender, idempotency key)` retries deterministic.
5. Keep task participants fixed and keep replies inside the original pair/task.
6. Use wake events only to trigger `listMessages()`; never trust an event body
   as durable delivery truth.
7. Mark delivery only after every application handler accepts the message.
8. Keep acknowledgement explicit and separate from handler acceptance.
9. Quarantine malformed or misrouted durable envelopes so one poison row
   cannot block every later message.
10. Page in stable `(created_at, id)` order and reject a cursor that does not
    advance.
11. Poll task events after the global `event_position`, advance only after all
    handlers accept, and enforce per-task sequence/causation continuity.
12. Keep MCP OAuth, short-lived Data, and short-lived Realtime credentials in
    separate authority domains. Never send a transport credential to MCP.

## OAuth and secret handling

`RacpMcpOAuthProvider` delegates discovery, dynamic registration, S256 PKCE,
code exchange, issuer validation, and refresh rotation to the official MCP
client. The host owns browser navigation and implements `RacpMcpOAuthStorage`
with atomic replacement and a namespace-scoped exclusive lock that spans the
entire refresh/rotation operation across processes. The SDK ships no plaintext token-file adapter and
accepts no manual bearer in `createHostedRacpAgent()`.

## Local development

`examples/local-adapter.ts` is intentionally small and in-memory. It is useful
for tests and contract exploration, not production. A production adapter must
add durable transactions, authenticated ownership checks, retry-safe writes,
bounded reads, observability, and shutdown/reconnect behavior appropriate to
its transport.

## Daemon bridge

If a local process must expose RACP to another runtime, implement
`RacpBridgeDriver` in `@rnby/racp-bridge`. The driver owns its socket or HTTP
listener and receives an already constructed `RacpBridgeContext`. The default
stub opens nothing and fails closed until that driver is supplied.
