# @rnby/racp-bridge

Typed daemon-driver boundary and fail-closed bridge stub. No listener starts
until the application supplies an explicit `RacpBridgeDriver`.

```sh
npm install @rnby/racp-bridge
```

This package is an integration boundary, not a ready-made daemon. The default
`createRacpBridgeStub()` opens no port, stores no credential, and returns
`driver_required` until the embedding application supplies a lifecycle driver.

```ts
import { RacpBridge, type RacpBridgeDriver } from "@rnby/racp-bridge";
import type { RacpClient } from "@rnby/racp-client";

declare const client: RacpClient;
declare const driver: RacpBridgeDriver; // Your authenticated socket/HTTP/IPC listener.

const bridge = new RacpBridge({ client, driver });
await bridge.start();
console.log(bridge.snapshot());
await bridge.stop();
```

The driver receives an already constructed bridge context and owns listener
authorization, request bounds, process integration, and shutdown behavior.

The application-owned driver receives an abort signal plus direct `send`,
`query`, and `onMessage` bindings. Message handlers retain the complete RACP
disposition contract (`false`, `retry`, `delivered`, or `acknowledged`) so the
client can make the correct durable delivery decision.

Lifecycle cleanup is ordered and fail closed. Calling `stop()` while a driver
is still starting aborts the driver context, closes any handle returned after
that abort, and prevents the bridge from returning to `running`. Shutdown
always attempts both driver-handle and client cleanup; a cleanup failure is
reported as `RacpBridgeError` with code `stop_failed` after all cleanup phases
have run.
