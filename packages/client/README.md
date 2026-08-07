# @rnby/racp-client

Event-driven RACP client with an injected durable adapter, capability routing,
causally ordered durable task updates, and `racp_send`, `racp_query`,
`racp_discover`, and `racp_task_create` helpers.

```sh
npm install @rnby/racp-client
```

Message handlers choose `delivered`, `acknowledged`, or retry semantics without
performing competing delivery-state writes inside the callback.
Inject a `RacpAdapter` for the durable transport; the package does not open a
listener or start a daemon on import.

Use [`@rnby/racp-agent`](https://www.npmjs.com/package/@rnby/racp-agent) when
you want RnBy's OAuth-backed hosted adapter rather than implementing the
adapter contract yourself.

```ts
import { RacpClient, type RacpAdapter } from "@rnby/racp-client";

declare const adapter: RacpAdapter;
const client = new RacpClient({ agentName: "@reviewer", adapter });

client.onMessage((message) => {
  console.log(new TextDecoder().decode(message.payload));
  return "acknowledged";
});

await client.start();
await client.send({
  toAgent: "@planner",
  intent: "STATUS",
  payload: new TextEncoder().encode("Review complete."),
});
```

Realtime or pub/sub events are wake signals only. A production adapter must
make its durable `listMessages()` result authoritative and enforce identity and
workspace isolation on every operation.
