# @rnby/racp-codec

Strict, dependency-free RACP v1 binary envelope codec with SHA-256 integrity,
bounded fields, and byte-oriented `pack`, `unpack`, and conversion helpers.

```sh
npm install @rnby/racp-codec
```

The language-neutral golden vectors live in the
[`rnby-ai/racp`](https://github.com/rnby-ai/racp) repository.

```ts
import { RACP_INTENT_CODES, pack, unpack } from "@rnby/racp-codec";

const { envelope } = await pack({
  intentCode: RACP_INTENT_CODES.QUERY,
  fromAgent: "@planner",
  toAgent: "@reviewer",
  sentAtMillis: Date.now(),
  payload: new TextEncoder().encode("Review this change."),
});

const decoded = await unpack(envelope);
console.log(decoded.fromAgent, decoded.toAgent, decoded.intent);
```

`unpack()` validates the complete payload SHA-256 and throws a typed
`RacpCodecError` on malformed input. Use `tryUnpack()` at untrusted boundaries
that should return a result instead of throwing.
