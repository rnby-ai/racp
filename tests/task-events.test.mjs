import assert from "node:assert/strict";
import test from "node:test";
import {
  RacpClient,
  RacpMcpTaskEventSource,
  parseTaskEventPage,
} from "@rnby/racp-client";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ONE = "33333333-3333-4333-8333-333333333333";
const EVENT_TWO = "44444444-4444-4444-8444-444444444444";

function rawEvent({
  id = EVENT_ONE,
  position = 1,
  sequence = 1,
  causationEventId = null,
  status = "created",
  eventType = "created",
} = {}) {
  return {
    id,
    tenant_id: TENANT_ID,
    task_id: TASK_ID,
    event_position: String(position),
    sequence: String(sequence),
    causation_event_id: causationEventId,
    actor_agent: "@worker",
    event_type: eventType,
    status,
    payload: { source: "test" },
    occurred_at: "2026-08-06T12:00:00.000Z",
    created_at: "2026-08-06T12:00:00.000Z",
  };
}

test("MCP task-event source calls the exact public tool and validates cursor pages", async () => {
  const calls = [];
  const source = new RacpMcpTaskEventSource({
    async call(name, args) {
      calls.push({ name, args });
      return {
        events: [rawEvent({ position: 8 })],
        next_cursor: { position: "8" },
        has_more: false,
      };
    },
  });
  const page = await source.fetchTaskEvents({
    agentName: "@worker",
    cursor: { position: 7 },
    limit: 25,
  });
  assert.equal(page.events[0].position, 8);
  assert.deepEqual(calls, [
    {
      name: "rnby_racp_get_task_events",
      args: { agent_name: "@worker", after_position: 7, limit: 25 },
    },
  ]);

  assert.throws(() =>
    parseTaskEventPage({
      events: [rawEvent({ position: 9 }), rawEvent({ id: EVENT_TWO, position: 8 })],
      next_cursor: { position: 8 },
      has_more: false,
    }, { position: 7 }),
  );
  assert.throws(() =>
    parseTaskEventPage({ events: [], next_cursor: null, has_more: true }),
  );
});

class NoopAdapter {
  connection = null;

  async connect(input) {
    this.connection = input;
    input.onStateChange("connected");
    return { close: async () => { this.connection = null; } };
  }

  async discover() { return []; }
  async listMessages() { return { messages: [], nextCursor: null }; }
  async persistMessage() { throw new Error("not used"); }
  async markDelivered() {}
  async markFailed() {}
  async acknowledge() {}
  async createTask() { throw new Error("not used"); }
  async updateTask() { throw new Error("not used"); }
}

class MemoryTaskEventSource {
  events = [];
  cursors = [];

  async fetchTaskEvents(input) {
    this.cursors.push(input.cursor?.position ?? null);
    const events = this.events
      .filter((event) => event.position > (input.cursor?.position ?? 0))
      .slice(0, input.limit);
    return {
      events,
      nextCursor: events.length
        ? { position: events.at(-1).position }
        : null,
      hasMore: false,
    };
  }
}

function event({ id, position, sequence, causationEventId, status, eventType }) {
  return {
    id,
    tenantId: TENANT_ID,
    taskId: TASK_ID,
    position,
    sequence,
    causationEventId,
    actorAgent: "@worker",
    eventType,
    status,
    payload: {},
    occurredAt: "2026-08-06T12:00:00.000Z",
    createdAt: "2026-08-06T12:00:00.000Z",
  };
}

test("onTaskUpdate drains causally, retries rejected callbacks, and resumes its cursor", async () => {
  const adapter = new NoopAdapter();
  const source = new MemoryTaskEventSource();
  source.events.push(event({
    id: EVENT_ONE,
    position: 1,
    sequence: 1,
    causationEventId: null,
    status: "created",
    eventType: "created",
  }));
  const client = new RacpClient({
    agentName: "@worker",
    adapter,
    taskEventSource: source,
    taskEventPollMs: 60_000,
  });
  const accepted = [];
  const errors = [];
  let rejectSecondOnce = true;
  client.onError((error) => errors.push(error));
  client.onTaskUpdate((update) => {
    if (update.sequence === 2 && rejectSecondOnce) {
      rejectSecondOnce = false;
      return false;
    }
    accepted.push(update.id);
    return true;
  });
  await client.start();
  assert.deepEqual(accepted, [EVENT_ONE]);

  source.events.push(event({
    id: EVENT_TWO,
    position: 2,
    sequence: 2,
    causationEventId: EVENT_ONE,
    status: "working",
    eventType: "working",
  }));
  adapter.connection.onStateChange("connected");
  await waitFor(() => errors.length === 1);
  assert.deepEqual(accepted, [EVENT_ONE]);

  adapter.connection.onStateChange("connected");
  await waitFor(() => accepted.length === 2);
  assert.deepEqual(accepted, [EVENT_ONE, EVENT_TWO]);
  assert.deepEqual(source.cursors.slice(-2), [1, 1]);

  await client.stop();
  await client.start();
  assert.equal(source.cursors.at(-1), 2);
  assert.deepEqual(accepted, [EVENT_ONE, EVENT_TWO]);
  await client.stop();
});

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
