const RACP_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RACP_AGENT_NAME_PATTERN =
  /^@[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/;
const RACP_EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const RACP_TASK_STATUSES = [
  "created",
  "working",
  "completed",
  "failed",
  "aborted",
] as const;

export type RacpTaskStatus = (typeof RACP_TASK_STATUSES)[number];

export type RacpTaskEventJson =
  | null
  | boolean
  | number
  | string
  | readonly RacpTaskEventJson[]
  | { readonly [key: string]: RacpTaskEventJson };

/** Globally monotonic durable cursor assigned by the task-event store. */
export interface RacpTaskEventCursor {
  position: number;
}

export interface RacpTaskEvent {
  id: string;
  tenantId: string;
  taskId: string;
  position: number;
  /** Monotonic sequence scoped to one task. */
  sequence: number;
  /** Previous event for this task, or null for its first durable event. */
  causationEventId: string | null;
  actorAgent: string;
  eventType: string;
  status: RacpTaskStatus;
  payload: Readonly<Record<string, RacpTaskEventJson>>;
  occurredAt: string;
  createdAt: string;
}

export interface RacpTaskEventPage {
  events: readonly RacpTaskEvent[];
  nextCursor: RacpTaskEventCursor | null;
  hasMore: boolean;
}

export interface RacpTaskEventFetchInput {
  agentName: string;
  cursor: RacpTaskEventCursor | null;
  limit: number;
  signal?: AbortSignal;
}

/** Durable task-event source. Implementations must page after event_position. */
export interface RacpTaskEventSource {
  fetchTaskEvents(input: RacpTaskEventFetchInput): Promise<RacpTaskEventPage>;
}

export interface RacpTaskEventMcpCaller {
  call<T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T>;
}

/**
 * Adapts the public RnBy MCP task-event tool to the transport-neutral source.
 * Authentication remains owned by the injected caller and is never stored.
 */
export class RacpMcpTaskEventSource implements RacpTaskEventSource {
  private readonly caller: RacpTaskEventMcpCaller;

  constructor(caller: RacpTaskEventMcpCaller) {
    this.caller = caller;
  }

  async fetchTaskEvents(
    input: RacpTaskEventFetchInput,
  ): Promise<RacpTaskEventPage> {
    assertAgentName(input.agentName);
    assertPageLimit(input.limit);
    if (input.cursor) assertCursor(input.cursor);
    throwIfAborted(input.signal);

    const result = await this.caller.call<Record<string, unknown>>(
      "rnby_racp_get_task_events",
      {
        agent_name: input.agentName,
        ...(input.cursor ? { after_position: input.cursor.position } : {}),
        limit: input.limit,
      },
      { ...(input.signal ? { signal: input.signal } : {}) },
    );
    throwIfAborted(input.signal);
    return parseTaskEventPage(result, input.cursor);
  }
}

export function parseTaskEventPage(
  value: unknown,
  after: RacpTaskEventCursor | null = null,
): RacpTaskEventPage {
  if (!isRecord(value) || !Array.isArray(value.events)) {
    throw new TypeError("RACP task-event query returned an invalid page.");
  }
  if (value.events.length > 250 || typeof value.has_more !== "boolean") {
    throw new TypeError("RACP task-event query returned an invalid page.");
  }

  const events = value.events.map(parseTaskEvent);
  let lastPosition = after?.position ?? 0;
  const eventIds = new Set<string>();
  for (const event of events) {
    if (event.position <= lastPosition || eventIds.has(event.id)) {
      throw new TypeError("RACP task-event page was not strictly ordered.");
    }
    lastPosition = event.position;
    eventIds.add(event.id);
  }

  const nextCursor = value.next_cursor === null
    ? null
    : parseCursor(value.next_cursor);
  if (events.length > 0) {
    const expected = events.at(-1)?.position;
    if (!nextCursor || nextCursor.position !== expected) {
      throw new TypeError("RACP task-event page cursor did not match its rows.");
    }
  } else if (nextCursor !== null) {
    throw new TypeError("An empty RACP task-event page cannot advance a cursor.");
  }
  if (value.has_more && events.length === 0) {
    throw new TypeError("RACP task-event page claimed more rows without progress.");
  }

  return { events, nextCursor, hasMore: value.has_more };
}

export function parseTaskEvent(value: unknown): RacpTaskEvent {
  if (!isRecord(value)) {
    throw new TypeError("RACP task-event query returned an invalid event.");
  }
  const id = stringValue(value.id);
  const tenantId = stringValue(value.tenant_id);
  const taskId = stringValue(value.task_id);
  const actorAgent = stringValue(value.actor_agent);
  const causationEventId = value.causation_event_id === null
    ? null
    : stringValue(value.causation_event_id);
  const eventType = stringValue(value.event_type);
  const occurredAt = stringValue(value.occurred_at);
  const createdAt = stringValue(value.created_at);
  const position = positiveSafeInteger(value.event_position);
  const sequence = positiveSafeInteger(value.sequence);
  const status = value.status;

  if (
    !RACP_UUID_PATTERN.test(id) ||
    !RACP_UUID_PATTERN.test(tenantId) ||
    !RACP_UUID_PATTERN.test(taskId) ||
    (causationEventId !== null && !RACP_UUID_PATTERN.test(causationEventId)) ||
    !RACP_AGENT_NAME_PATTERN.test(actorAgent) ||
    !RACP_EVENT_TYPE_PATTERN.test(eventType) ||
    !isTaskStatus(status) ||
    !isJsonRecord(value.payload) ||
    !isBoundedJsonRecord(value.payload) ||
    !isTimestamp(occurredAt) ||
    !isTimestamp(createdAt)
  ) {
    throw new TypeError("RACP task-event query returned an invalid event.");
  }

  return {
    id,
    tenantId,
    taskId,
    position,
    sequence,
    causationEventId,
    actorAgent,
    eventType,
    status,
    payload: value.payload,
    occurredAt,
    createdAt,
  };
}

export function assertCausalTaskEvent(
  event: RacpTaskEvent,
  lastSequence: number | undefined,
  lastEventId?: string,
): void {
  if (lastSequence === undefined) {
    if (event.sequence !== 1 || event.causationEventId !== null) {
      throw new TypeError(
        `RACP task ${event.taskId} did not begin with an uncaused sequence 1 event.`,
      );
    }
    return;
  }
  if (event.sequence !== lastSequence + 1) {
    throw new TypeError(
      `RACP task ${event.taskId} sequence ${event.sequence} did not follow ${lastSequence}.`,
    );
  }
  if (lastEventId !== undefined && event.causationEventId !== lastEventId) {
    throw new TypeError(
      `RACP task ${event.taskId} did not reference its prior causal event.`,
    );
  }
}

function parseCursor(value: unknown): RacpTaskEventCursor {
  if (!isRecord(value)) {
    throw new TypeError("RACP task-event query returned an invalid cursor.");
  }
  const cursor = { position: positiveSafeInteger(value.position) };
  assertCursor(cursor);
  return cursor;
}

function assertCursor(cursor: RacpTaskEventCursor): void {
  if (!Number.isSafeInteger(cursor.position) || cursor.position < 1) {
    throw new TypeError("RACP task-event cursor must be a positive integer.");
  }
}

function assertPageLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 250) {
    throw new TypeError("RACP task-event page limit must be between 1 and 250.");
  }
}

function assertAgentName(value: string): void {
  if (!RACP_AGENT_NAME_PATTERN.test(value)) {
    throw new TypeError("RACP task-event query requires a canonical agent name.");
  }
}

function positiveSafeInteger(value: unknown): number {
  const parsed = typeof value === "string" && /^[1-9][0-9]*$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 1) {
    throw new TypeError(
      "RACP task-event position and sequence must be positive integers.",
    );
  }
  return Number(parsed);
}

function isTaskStatus(value: unknown): value is RacpTaskStatus {
  return typeof value === "string" &&
    (RACP_TASK_STATUSES as readonly string[]).includes(value);
}

function isTimestamp(value: string): boolean {
  return value.length > 0 && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("The RACP task-event query was aborted.", "AbortError");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonRecord(
  value: unknown,
): value is Readonly<Record<string, RacpTaskEventJson>> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isBoundedJsonRecord(value: Record<string, unknown>): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 65_536;
  } catch {
    return false;
  }
}

function isJsonValue(value: unknown): value is RacpTaskEventJson {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonRecord(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
