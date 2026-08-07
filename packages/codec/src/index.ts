const RACP_MAGIC_BYTES = Uint8Array.of(0x52, 0x41, 0x43, 0x50);
const RACP_AGENT_NAME_PATTERN =
  /^@[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/;
const RACP_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RACP_NIL_TASK_ID = "00000000-0000-0000-0000-000000000000";

export const RACP_PROTOCOL_VERSION = 1 as const;
export const RACP_MIN_AGENT_NAME_BYTES = 2;
export const RACP_MAX_AGENT_NAME_BYTES = 64;
export const RACP_MAX_INLINE_PAYLOAD_BYTES = 65_535;
export const RACP_PAYLOAD_HASH_PREFIX_BYTES = 8;
export const RACP_PAYLOAD_HASH_BYTES = 32;
export const RACP_MIN_ENVELOPE_BYTES = 48;
export const RACP_MAX_ENVELOPE_BYTES = 65_707;
export const RACP_MAX_PERSISTABLE_TIMESTAMP_MILLIS = BigInt(
  "8640000000000000",
);

export const RACP_INTENT_CODES = Object.freeze({
  QUERY: 0x01,
  TASK: 0x02,
  RESPONSE: 0x03,
  ARTIFACT: 0x04,
  HANDOFF: 0x05,
  STATUS: 0x06,
  ERROR: 0x07,
  THINKING: 0x10,
  TOOL_CALL: 0x11,
  INTERMEDIATE: 0x12,
  FINAL: 0x13,
  ABORT: 0x14,
  HEARTBEAT: 0x15,
  BACKPRESSURE: 0x16,
} as const);

export type RacpIntentName = keyof typeof RACP_INTENT_CODES;
export type RacpIntentCode = (typeof RACP_INTENT_CODES)[RacpIntentName];
export type RacpByteSource = ArrayBuffer | ArrayBufferView;
export type RacpTimestampMillis = number | bigint;

export type RacpV1PackInput = Readonly<{
  intentCode: RacpIntentCode;
  fromAgent: string;
  toAgent: string;
  taskId?: string | null;
  sentAtMillis: RacpTimestampMillis;
  payload: RacpByteSource;
}>;

export type RacpV1PackedEnvelope = Readonly<{
  envelope: Uint8Array;
  payloadHash: Uint8Array;
}>;

export type RacpV1Envelope = Readonly<{
  version: typeof RACP_PROTOCOL_VERSION;
  intent: RacpIntentName;
  intentCode: RacpIntentCode;
  fromAgent: string;
  toAgent: string;
  taskId: string | null;
  sentAtMillis: bigint;
  payloadHash: Uint8Array;
  wirePayloadHash: Uint8Array;
  payload: Uint8Array;
}>;

export type RacpCodecErrorCode =
  | "invalid_input"
  | "truncated_frame"
  | "frame_too_large"
  | "invalid_magic"
  | "unsupported_version"
  | "invalid_intent"
  | "invalid_utf8"
  | "invalid_agent_name"
  | "invalid_task_id"
  | "invalid_timestamp"
  | "payload_too_large"
  | "trailing_bytes"
  | "payload_hash_mismatch"
  | "hash_unavailable";

export type RacpUnpackResult =
  | Readonly<{ ok: true; envelope: RacpV1Envelope }>
  | Readonly<{
      ok: false;
      code: RacpCodecErrorCode;
      message: string;
      offset?: number;
    }>;

export class RacpCodecError extends Error {
  readonly code: RacpCodecErrorCode;
  readonly offset: number | undefined;

  constructor(code: RacpCodecErrorCode, message: string, offset?: number) {
    super(message);
    this.name = "RacpCodecError";
    this.code = code;
    this.offset = offset;
  }
}

const INTENT_NAME_BY_CODE = new Map<RacpIntentCode, RacpIntentName>(
  Object.entries(RACP_INTENT_CODES).map(([name, code]) => [
    code,
    name as RacpIntentName,
  ]),
);
const textEncoder = new TextEncoder();
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function isRacpIntentCode(value: number): value is RacpIntentCode {
  return (
    Number.isInteger(value) && INTENT_NAME_BY_CODE.has(value as RacpIntentCode)
  );
}

export function intentCodeForName(name: string): RacpIntentCode {
  const code = RACP_INTENT_CODES[name.toUpperCase() as RacpIntentName];
  if (code === undefined) {
    throw new RacpCodecError(
      "invalid_intent",
      "RACP v1 intent name is not recognized.",
    );
  }
  return code;
}

/** Pack one strict RACP v1 inline envelope. */
export async function pack(
  input: RacpV1PackInput,
): Promise<RacpV1PackedEnvelope> {
  if (!input || typeof input !== "object") {
    throw new RacpCodecError(
      "invalid_input",
      "RACP pack input must be an object.",
    );
  }

  const payload = copyByteSource(input.payload, "payload");
  if (payload.byteLength > RACP_MAX_INLINE_PAYLOAD_BYTES) {
    throw new RacpCodecError(
      "payload_too_large",
      `RACP v1 inline payloads cannot exceed ${RACP_MAX_INLINE_PAYLOAD_BYTES} bytes.`,
    );
  }
  if (!isRacpIntentCode(input.intentCode)) {
    throw new RacpCodecError(
      "invalid_intent",
      "RACP v1 intent code is not recognized.",
      5,
    );
  }

  const fromBytes = encodeAgentName(input.fromAgent, "fromAgent");
  const toBytes = encodeAgentName(input.toAgent, "toAgent");
  const taskBytes = encodeTaskId(input.taskId ?? null);
  const sentAtMillis = normalizeTimestampMillis(input.sentAtMillis);
  const payloadHash = await sha256OwnedBytes(payload);
  const envelope = new Uint8Array(
    44 + fromBytes.byteLength + toBytes.byteLength + payload.byteLength,
  );
  const view = new DataView(envelope.buffer);
  let cursor = 0;

  envelope.set(RACP_MAGIC_BYTES, cursor);
  cursor += 4;
  envelope[cursor++] = RACP_PROTOCOL_VERSION;
  envelope[cursor++] = input.intentCode;
  view.setUint16(cursor, fromBytes.byteLength, false);
  cursor += 2;
  envelope.set(fromBytes, cursor);
  cursor += fromBytes.byteLength;
  view.setUint16(cursor, toBytes.byteLength, false);
  cursor += 2;
  envelope.set(toBytes, cursor);
  cursor += toBytes.byteLength;
  envelope.set(taskBytes, cursor);
  cursor += 16;
  view.setBigUint64(cursor, sentAtMillis, false);
  cursor += 8;
  envelope.set(payloadHash.subarray(0, RACP_PAYLOAD_HASH_PREFIX_BYTES), cursor);
  cursor += RACP_PAYLOAD_HASH_PREFIX_BYTES;
  view.setUint16(cursor, payload.byteLength, false);
  cursor += 2;
  envelope.set(payload, cursor);

  return { envelope, payloadHash };
}

/** Unpack and SHA-256-verify one strict RACP v1 inline envelope. */
export async function unpack(source: RacpByteSource): Promise<RacpV1Envelope> {
  const decoded = decodeStructure(source);
  const payloadHash = await sha256OwnedBytes(decoded.payload);
  if (!equalPrefix(payloadHash, decoded.wirePayloadHash)) {
    throw new RacpCodecError(
      "payload_hash_mismatch",
      "RACP payload does not match the digest prefix carried by the envelope.",
      decoded.hashOffset,
    );
  }
  return {
    version: RACP_PROTOCOL_VERSION,
    intent: decoded.intent,
    intentCode: decoded.intentCode,
    fromAgent: decoded.fromAgent,
    toAgent: decoded.toAgent,
    taskId: decoded.taskId,
    sentAtMillis: decoded.sentAtMillis,
    payloadHash,
    wirePayloadHash: decoded.wirePayloadHash,
    payload: decoded.payload,
  };
}

/** Never throws for malformed or unverifiable RACP bytes. */
export async function tryUnpack(
  source: RacpByteSource,
): Promise<RacpUnpackResult> {
  try {
    return { ok: true, envelope: await unpack(source) };
  } catch (error) {
    if (!(error instanceof RacpCodecError)) throw error;
    return {
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.offset === undefined ? {} : { offset: error.offset }),
    };
  }
}

export async function hashPayload(
  source: RacpByteSource,
): Promise<Uint8Array> {
  return sha256OwnedBytes(copyByteSource(source, "payload"));
}

type DecodedStructure = Omit<RacpV1Envelope, "version" | "payloadHash"> & {
  hashOffset: number;
};

function decodeStructure(source: RacpByteSource): DecodedStructure {
  const envelope = copyByteSource(source, "envelope");
  if (envelope.byteLength < RACP_MIN_ENVELOPE_BYTES) {
    throw new RacpCodecError(
      "truncated_frame",
      `RACP v1 frames must be at least ${RACP_MIN_ENVELOPE_BYTES} bytes.`,
      envelope.byteLength,
    );
  }
  if (envelope.byteLength > RACP_MAX_ENVELOPE_BYTES) {
    throw new RacpCodecError(
      "frame_too_large",
      `RACP v1 frames cannot exceed ${RACP_MAX_ENVELOPE_BYTES} bytes.`,
      RACP_MAX_ENVELOPE_BYTES,
    );
  }

  const view = new DataView(
    envelope.buffer,
    envelope.byteOffset,
    envelope.byteLength,
  );
  let cursor = 0;
  for (let index = 0; index < RACP_MAGIC_BYTES.byteLength; index += 1) {
    if (envelope[index] !== RACP_MAGIC_BYTES[index]) {
      throw new RacpCodecError(
        "invalid_magic",
        "RACP frame magic must be ASCII RACP.",
        index,
      );
    }
  }
  cursor += 4;

  const version = envelope[cursor];
  if (version !== RACP_PROTOCOL_VERSION) {
    throw new RacpCodecError(
      "unsupported_version",
      `Unsupported RACP wire version ${String(version)}.`,
      cursor,
    );
  }
  cursor += 1;

  const rawIntentCode = envelope[cursor];
  if (rawIntentCode === undefined || !isRacpIntentCode(rawIntentCode)) {
    throw new RacpCodecError(
      "invalid_intent",
      "RACP v1 intent code is not recognized.",
      cursor,
    );
  }
  const intentCode = rawIntentCode;
  const intent = INTENT_NAME_BY_CODE.get(intentCode);
  if (!intent) {
    throw new RacpCodecError(
      "invalid_intent",
      "RACP v1 intent code is not recognized.",
      cursor,
    );
  }
  cursor += 1;

  const from = decodeAgentName(envelope, view, cursor, "sender");
  cursor = from.nextOffset;
  const to = decodeAgentName(envelope, view, cursor, "recipient");
  cursor = to.nextOffset;
  requireBytes(envelope, cursor, 16);
  const taskId = decodeTaskId(envelope.slice(cursor, cursor + 16));
  cursor += 16;
  requireBytes(envelope, cursor, 8);
  const sentAtMillis = view.getBigUint64(cursor, false);
  cursor += 8;
  const hashOffset = cursor;
  requireBytes(envelope, cursor, RACP_PAYLOAD_HASH_PREFIX_BYTES);
  const wirePayloadHash = envelope.slice(
    cursor,
    cursor + RACP_PAYLOAD_HASH_PREFIX_BYTES,
  );
  cursor += RACP_PAYLOAD_HASH_PREFIX_BYTES;
  requireBytes(envelope, cursor, 2);
  const payloadLength = view.getUint16(cursor, false);
  cursor += 2;

  const availablePayloadBytes = envelope.byteLength - cursor;
  if (availablePayloadBytes < payloadLength) {
    throw new RacpCodecError(
      "truncated_frame",
      "RACP payload is shorter than its declared byte length.",
      envelope.byteLength,
    );
  }
  if (availablePayloadBytes > payloadLength) {
    throw new RacpCodecError(
      "trailing_bytes",
      "RACP frame contains bytes after its declared payload.",
      cursor + payloadLength,
    );
  }

  return {
    intent,
    intentCode,
    fromAgent: from.name,
    toAgent: to.name,
    taskId,
    sentAtMillis,
    wirePayloadHash,
    payload: envelope.slice(cursor),
    hashOffset,
  };
}

function copyByteSource(source: RacpByteSource, label: string): Uint8Array {
  try {
    if (source instanceof ArrayBuffer) {
      return new Uint8Array(source.slice(0));
    }
    if (ArrayBuffer.isView(source)) {
      const copy = new Uint8Array(source.byteLength);
      copy.set(
        new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
      );
      return copy;
    }
  } catch {
    throw new RacpCodecError(
      "invalid_input",
      `RACP ${label} must reference readable bytes.`,
    );
  }
  throw new RacpCodecError(
    "invalid_input",
    `RACP ${label} must be an ArrayBuffer or ArrayBuffer view.`,
  );
}

function encodeAgentName(name: string, field: string): Uint8Array {
  if (typeof name !== "string" || !RACP_AGENT_NAME_PATTERN.test(name)) {
    throw new RacpCodecError(
      "invalid_agent_name",
      `RACP ${field} must be a canonical lowercase @agent name.`,
    );
  }
  const bytes = textEncoder.encode(name);
  if (
    bytes.byteLength < RACP_MIN_AGENT_NAME_BYTES ||
    bytes.byteLength > RACP_MAX_AGENT_NAME_BYTES
  ) {
    throw new RacpCodecError(
      "invalid_agent_name",
      `RACP ${field} must encode to ${RACP_MIN_AGENT_NAME_BYTES}..${RACP_MAX_AGENT_NAME_BYTES} UTF-8 bytes.`,
    );
  }
  return bytes;
}

function decodeAgentName(
  envelope: Uint8Array,
  view: DataView,
  lengthOffset: number,
  label: string,
) {
  requireBytes(envelope, lengthOffset, 2);
  const byteLength = view.getUint16(lengthOffset, false);
  if (
    byteLength < RACP_MIN_AGENT_NAME_BYTES ||
    byteLength > RACP_MAX_AGENT_NAME_BYTES
  ) {
    throw new RacpCodecError(
      "invalid_agent_name",
      `RACP ${label} name length must be ${RACP_MIN_AGENT_NAME_BYTES}..${RACP_MAX_AGENT_NAME_BYTES} bytes.`,
      lengthOffset,
    );
  }
  const nameOffset = lengthOffset + 2;
  requireBytes(envelope, nameOffset, byteLength);
  let name: string;
  try {
    name = fatalUtf8Decoder.decode(
      envelope.subarray(nameOffset, nameOffset + byteLength),
    );
  } catch {
    throw new RacpCodecError(
      "invalid_utf8",
      `RACP ${label} name is not valid UTF-8.`,
      nameOffset,
    );
  }
  if (!RACP_AGENT_NAME_PATTERN.test(name)) {
    throw new RacpCodecError(
      "invalid_agent_name",
      `RACP ${label} name is not a canonical lowercase @agent name.`,
      nameOffset,
    );
  }
  return { name, nextOffset: nameOffset + byteLength };
}

function encodeTaskId(taskId: string | null): Uint8Array {
  if (taskId === null) return new Uint8Array(16);
  if (typeof taskId !== "string" || !RACP_UUID_PATTERN.test(taskId)) {
    throw new RacpCodecError(
      "invalid_task_id",
      "RACP taskId must be a canonical UUID or null.",
    );
  }
  const normalized = taskId.toLowerCase();
  if (normalized === RACP_NIL_TASK_ID) {
    throw new RacpCodecError(
      "invalid_task_id",
      "The nil UUID is reserved as RACP's null task sentinel.",
    );
  }
  const hex = normalized.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function decodeTaskId(bytes: Uint8Array): string | null {
  let hasNonZeroByte = false;
  let hex = "";
  for (const byte of bytes) {
    hasNonZeroByte ||= byte !== 0;
    hex += byte.toString(16).padStart(2, "0");
  }
  if (!hasNonZeroByte) return null;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function normalizeTimestampMillis(value: RacpTimestampMillis): bigint {
  let timestamp: bigint;
  if (typeof value === "bigint") timestamp = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) {
    timestamp = BigInt(value);
  } else {
    throw new RacpCodecError(
      "invalid_timestamp",
      "RACP sentAtMillis must be a bigint or safe integer.",
    );
  }
  if (
    timestamp < BigInt(0) ||
    timestamp > RACP_MAX_PERSISTABLE_TIMESTAMP_MILLIS
  ) {
    throw new RacpCodecError(
      "invalid_timestamp",
      "RACP sentAtMillis must fit the shared JavaScript Date and PostgreSQL TIMESTAMPTZ range.",
    );
  }
  return timestamp;
}

function requireBytes(
  envelope: Uint8Array,
  offset: number,
  byteLength: number,
) {
  if (offset + byteLength > envelope.byteLength) {
    throw new RacpCodecError(
      "truncated_frame",
      "RACP frame ended before all declared fields were available.",
      envelope.byteLength,
    );
  }
}

async function sha256OwnedBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) {
    throw new RacpCodecError(
      "hash_unavailable",
      "Web Crypto SHA-256 is required for the RACP v1 inline profile.",
    );
  }
  try {
    return new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", bytes.slice()),
    );
  } catch {
    throw new RacpCodecError(
      "hash_unavailable",
      "Web Crypto could not compute the RACP v1 SHA-256 digest.",
    );
  }
}

function equalPrefix(fullHash: Uint8Array, wireHash: Uint8Array) {
  let difference = 0;
  for (let index = 0; index < RACP_PAYLOAD_HASH_PREFIX_BYTES; index += 1) {
    difference |= (fullHash[index] ?? 0) ^ (wireHash[index] ?? 0);
  }
  return difference === 0;
}

export function bytesToHex(source: RacpByteSource): string {
  return Array.from(copyByteSource(source, "bytes"), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function hexToBytes(value: string): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length % 2 !== 0 ||
    !/^[0-9a-f]*$/i.test(value)
  ) {
    throw new TypeError("Expected an even-length hexadecimal byte string.");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToBase64(source: RacpByteSource): string {
  const bytes = copyByteSource(source, "bytes");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new TypeError("Expected canonical padded base64 data.");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new TypeError("Expected canonical padded base64 data.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
