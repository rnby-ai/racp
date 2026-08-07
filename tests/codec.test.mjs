import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  RACP_INTENT_CODES,
  RACP_MAX_ENVELOPE_BYTES,
  RACP_MAX_INLINE_PAYLOAD_BYTES,
  RACP_PROTOCOL_VERSION,
  bytesToHex,
  hexToBytes,
  pack,
  tryUnpack,
  unpack,
} from "@rnby/racp-codec";

const fixture = JSON.parse(
  await readFile(
    new URL("./vectors/racp-v1-golden-vectors.json", import.meta.url),
    "utf8",
  ),
);

test("codec matches every language-neutral golden vector", async () => {
  assert.equal(RACP_PROTOCOL_VERSION, 1);
  assert.equal(fixture.vectors.length, 3);
  for (const vector of fixture.vectors) {
    const packed = await pack({
      intentCode: vector.intent_code,
      fromAgent: vector.from_agent,
      toAgent: vector.to_agent,
      taskId: vector.task_id,
      sentAtMillis: BigInt(vector.timestamp_ms),
      payload: hexToBytes(vector.payload_hex),
    });
    assert.equal(bytesToHex(packed.envelope), vector.envelope_hex, vector.name);
    assert.equal(
      bytesToHex(packed.payloadHash),
      vector.payload_sha256_hex,
      vector.name,
    );
    const decoded = await unpack(packed.envelope);
    assert.equal(decoded.intent, vector.intent, vector.name);
    assert.equal(decoded.taskId, vector.task_id, vector.name);
    assert.equal(bytesToHex(decoded.payload), vector.payload_hex, vector.name);
  }
});

test("codec rejects payload tampering and enforces exact bounds", async () => {
  const packed = await pack({
    intentCode: RACP_INTENT_CODES.QUERY,
    fromAgent: "@a",
    toAgent: "@b",
    sentAtMillis: 0,
    payload: new TextEncoder().encode("hello"),
  });
  const tampered = packed.envelope.slice();
  tampered[tampered.length - 1] ^= 1;
  const result = await tryUnpack(tampered);
  assert.equal(result.ok, false);
  assert.equal(result.code, "payload_hash_mismatch");

  const maxName = `@${"a".repeat(63)}`;
  const maximum = await pack({
    intentCode: RACP_INTENT_CODES.FINAL,
    fromAgent: maxName,
    toAgent: maxName,
    sentAtMillis: 0,
    payload: new Uint8Array(RACP_MAX_INLINE_PAYLOAD_BYTES),
  });
  assert.equal(maximum.envelope.length, RACP_MAX_ENVELOPE_BYTES);
});
