import assert from "node:assert/strict";
import test from "node:test";
import { pack, bytesToBase64, RACP_INTENT_CODES } from "@rnby/racp-codec";
import { RacpHostedAdapter } from "@rnby/racp-agent/hosted";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-08-06T12:00:00.000Z");

function credential(prefix, jti) {
  return {
    access_token: `${prefix}.payload.signature`,
    token_type: "Bearer",
    expires_in: 90,
    issued_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 90_000).toISOString(),
    jti,
  };
}

function discoveredAgent() {
  return {
    agentName: "@reviewer",
    card: { name: "Reviewer", skills: [] },
    cardRevision: 1,
    capabilityTags: ["code.review"],
    matchingSkills: [{ id: "code.review" }],
    highestTrust: "declared",
    availability: {
      status: "online",
      registeredStatus: "online",
      lastSeen: null,
      presenceExpiresAt: new Date(NOW + 90_000).toISOString(),
      leaseValid: true,
    },
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for hosted adapter callback.");
}

class FakeMcp {
  calls = [];
  closed = false;
  envelopeBase64 = "";

  async connect() {}

  async call(name, args) {
    this.calls.push({ name, args });
    if (name === "rnby_racp_register_agent" || name === "rnby_racp_heartbeat_agent") {
      return {
        agent: {
          id: "55555555-5555-4555-8555-555555555555",
          name: "@worker",
          machine: "test-machine",
          status: "offline",
          capabilities: {},
          owned_by_caller: true,
          last_seen: null,
          presence_expires_at: null,
        },
        credential: credential("data", "66666666-6666-4666-8666-666666666666"),
        realtime_credential: credential(
          "realtime",
          "77777777-7777-4777-8777-777777777777",
        ),
        transport_config: {
          tenant_id: TENANT_ID,
          tenant_slug: "tenant-example",
          supabase_url: "https://project.supabase.co",
          supabase_anon_key: "public-anon-key",
        },
      };
    }
    if (name === "rnby_racp_discover_agents") return [discoveredAgent()];
    if (name === "rnby_racp_route_agent") {
      return {
        routingId: "a".repeat(64),
        selectedAgent: discoveredAgent(),
        matchingSkill: {
          id: "code.review",
          name: "Code review",
          description: "Review code",
          tags: ["code.review"],
          inputModes: ["text"],
          outputModes: ["text"],
          trustLevel: "declared",
        },
        trustLevel: "declared",
        availability: discoveredAgent().availability,
        reason: "Selected deterministically for code review.",
        executionAuthority: "none",
      };
    }
    if (name === "rnby_racp_query_agents") {
      return {
        agents: [{
          name: "@reviewer",
          status: "online",
          machine: "remote",
          capabilities: { functions: ["code.review"] },
        }],
      };
    }
    if (name === "rnby_racp_get_messages") {
      return {
        messages: [{
          id: MESSAGE_ID,
          envelope_base64: this.envelopeBase64,
          created_at: "2026-08-06T12:00:00.000Z",
          idempotency_key: "incoming-1",
          reply_to_message_id: null,
          delivery_status: "queued",
          metadata: {},
        }],
        next_cursor: null,
        has_more: false,
      };
    }
    if (name === "rnby_racp_send_message") {
      return {
        message: {
          id: MESSAGE_ID,
          created_at: "2026-08-06T12:00:00.000Z",
          delivery_status: "queued",
        },
      };
    }
    if (name === "rnby_racp_create_task" || name === "rnby_racp_update_task") {
      return {
        task: {
          id: TASK_ID,
          created_by_agent: "@worker",
          assigned_to_agent: "@reviewer",
          status: name.endsWith("update_task") ? "working" : "created",
          artifacts: [],
          metadata: {},
          created_at: "2026-08-06T12:00:00.000Z",
          updated_at: "2026-08-06T12:00:00.000Z",
        },
      };
    }
    if (name === "rnby_racp_acknowledge_message") return { updated: true };
    throw new Error(`unexpected tool ${name}`);
  }

  async close() { this.closed = true; }
}

class FakeChannel {
  broadcastHandler = null;
  tracked = false;
  removed = false;
  statusHandler = null;

  constructor(initialStatus = "SUBSCRIBED") {
    this.initialStatus = initialStatus;
  }

  on(_type, _filter, callback) {
    this.broadcastHandler = callback;
    return this;
  }

  subscribe(callback) {
    this.statusHandler = callback;
    queueMicrotask(() => callback(this.initialStatus));
    return this;
  }

  async track() { this.tracked = true; return "ok"; }
  async untrack() { this.tracked = false; return "ok"; }
  emitWake(envelope) {
    const payload = envelope.slice().buffer;
    this.broadcastHandler?.({ type: "broadcast", event: "message", payload });
  }
  emitStatus(status, error) { this.statusHandler?.(status, error); }
}

function fakeSupabaseFactory(clients, initialStatuses = []) {
  return (_url, _key, options) => {
    const channels = [];
    const client = {
      options,
      channels,
      realtime: { async setAuth() {} },
      channel() {
        const channel = new FakeChannel(initialStatuses.shift());
        channels.push(channel);
        return channel;
      },
      async removeChannel(channel) { channel.removed = true; },
      async rpc() { return { data: "ok", error: null }; },
    };
    clients.push(client);
    return client;
  };
}

test("hosted adapter registers, opens Realtime, and maps durable MCP operations", async (t) => {
  const mcp = new FakeMcp();
  const incoming = await pack({
    intentCode: RACP_INTENT_CODES.QUERY,
    fromAgent: "@reviewer",
    toAgent: "@worker",
    taskId: null,
    sentAtMillis: 1,
    payload: new TextEncoder().encode("hello"),
  });
  mcp.envelopeBase64 = bytesToBase64(incoming.envelope);
  const clients = [];
  const adapter = new RacpHostedAdapter(
    {
      agentName: "@worker",
      tenantSlug: "tenant-example",
      machine: "test-machine",
      mcp,
    },
    {
      createSupabaseClient: fakeSupabaseFactory(clients),
      createId: () => "44444444-4444-4444-8444-444444444444",
      now: () => NOW,
    },
  );
  const controller = new AbortController();
  let wakes = 0;
  const states = [];
  const errors = [];
  const connection = await adapter.connect({
    agentName: "@worker",
    signal: controller.signal,
    onWake: () => { wakes += 1; },
    onError: (error) => errors.push(error),
    onStateChange: (state) => states.push(state),
  });
  t.after(async () => {
    controller.abort();
    await connection.close();
  });
  assert.equal(clients.length, 2);
  assert.equal(states.at(-1), "connected");
  clients[1].channels[0].emitWake(incoming.envelope);
  await waitFor(() => wakes === 1);
  assert.equal(wakes, 1);

  const closedMessageChannel = clients[1].channels[0];
  closedMessageChannel.emitStatus("CLOSED");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(closedMessageChannel.removed, true);
  assert.equal(clients[1].channels.length, 3);
  assert.equal(states.at(-1), "connected");
  assert.equal(errors.length, 1);

  const agents = await adapter.discover({ capability: "code.review", limit: 10 }, controller.signal);
  assert.equal(agents[0].name, "@reviewer");
  const routed = await adapter.routeCapability(
    { capability: "code.review" },
    controller.signal,
  );
  assert.equal(routed.name, "@reviewer");
  assert.equal(routed.metadata.route.routingId, "a".repeat(64));
  assert.equal(routed.metadata.route.executionAuthority, "none");
  assert.equal(
    mcp.calls.find((call) => call.name === "rnby_racp_discover_agents").args.status,
    "any",
  );
  assert.equal(
    mcp.calls.find((call) => call.name === "rnby_racp_route_agent").args.status,
    "any",
  );
  const page = await adapter.listMessages(
    { toAgent: "@worker", cursor: null, limit: 10 },
    controller.signal,
  );
  assert.equal(page.messages[0].id, MESSAGE_ID);

  const outgoing = await pack({
    intentCode: RACP_INTENT_CODES.QUERY,
    fromAgent: "@worker",
    toAgent: "@reviewer",
    taskId: TASK_ID,
    sentAtMillis: 2,
    payload: new TextEncoder().encode("review"),
  });
  const receipt = await adapter.persistMessage({
    protocolVersion: 1,
    intentCode: RACP_INTENT_CODES.QUERY,
    fromAgent: "@worker",
    toAgent: "@reviewer",
    taskId: TASK_ID,
    replyToMessageId: null,
    idempotencyKey: "outgoing-1",
    sentAtMillis: 2,
    payloadHash: outgoing.payloadHash,
    envelope: outgoing.envelope,
    metadata: {},
  }, controller.signal);
  assert.equal(receipt.id, MESSAGE_ID);
  assert.equal(
    mcp.calls.find((call) => call.name === "rnby_racp_send_message").args.payload_base64,
    bytesToBase64(new TextEncoder().encode("review")),
  );
  assert.equal(
    Object.hasOwn(
      mcp.calls.find((call) => call.name === "rnby_racp_send_message").args,
      "sent_at_millis",
    ),
    false,
  );
  const retryEnvelope = await pack({
    intentCode: RACP_INTENT_CODES.QUERY,
    fromAgent: "@worker",
    toAgent: "@reviewer",
    taskId: TASK_ID,
    sentAtMillis: 3,
    payload: new TextEncoder().encode("review"),
  });
  await adapter.persistMessage({
    protocolVersion: 1,
    intentCode: RACP_INTENT_CODES.QUERY,
    fromAgent: "@worker",
    toAgent: "@reviewer",
    taskId: TASK_ID,
    replyToMessageId: null,
    idempotencyKey: "outgoing-1",
    sentAtMillis: 3,
    payloadHash: retryEnvelope.payloadHash,
    envelope: retryEnvelope.envelope,
    metadata: {},
  }, controller.signal);
  const sendCalls = mcp.calls.filter(
    (call) => call.name === "rnby_racp_send_message",
  );
  assert.deepEqual(sendCalls[1].args, sendCalls[0].args);

  await assert.rejects(() => adapter.persistMessage({
    protocolVersion: 1,
    intentCode: RACP_INTENT_CODES.QUERY,
    fromAgent: "@impostor",
    toAgent: "@reviewer",
    taskId: TASK_ID,
    replyToMessageId: null,
    idempotencyKey: "outgoing-impostor",
    sentAtMillis: 2,
    payloadHash: outgoing.payloadHash,
    envelope: outgoing.envelope,
    metadata: {},
  }, controller.signal));

  const task = await adapter.createTask({
    id: TASK_ID,
    createdByAgent: "@worker",
    assignedToAgent: "@reviewer",
    metadata: {},
  }, controller.signal);
  assert.equal(task.status, "created");
  await assert.rejects(() => adapter.createTask({
    id: TASK_ID,
    createdByAgent: "@impostor",
    assignedToAgent: "@reviewer",
    metadata: {},
  }, controller.signal));
  await assert.rejects(() => adapter.updateTask({
    taskId: TASK_ID,
    actingAgent: "@impostor",
    status: "working",
  }, controller.signal));
  await adapter.acknowledge(MESSAGE_ID, controller.signal);
  await connection.close();
  assert.equal(mcp.closed, true);
  assert.equal(clients[1].channels.every((channel) => channel.removed), true);
});

test("hosted adapter preserves initial readiness while replacing a CLOSED channel", async () => {
  const clients = [];
  const adapter = new RacpHostedAdapter(
    {
      agentName: "@worker",
      tenantSlug: "tenant-example",
      machine: "test-machine",
      mcp: new FakeMcp(),
    },
    {
      createSupabaseClient: fakeSupabaseFactory(
        clients,
        ["CLOSED", "SUBSCRIBED", "SUBSCRIBED"],
      ),
      createId: () => "44444444-4444-4444-8444-444444444444",
      now: () => NOW,
    },
  );
  const controller = new AbortController();
  const connection = await Promise.race([
    adapter.connect({
      agentName: "@worker",
      signal: controller.signal,
      onWake() {},
      onError() {},
      onStateChange() {},
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("replacement did not become ready")), 250),
    ),
  ]);
  assert.equal(clients[1].channels.length, 3);
  await connection.close();
});

test("hosted adapter rejects a mismatched connection identity before registration", async () => {
  const mcp = new FakeMcp();
  const adapter = new RacpHostedAdapter(
    {
      agentName: "@worker",
      tenantSlug: "tenant-example",
      machine: "test-machine",
      mcp,
    },
    { createSupabaseClient: fakeSupabaseFactory([]), now: () => NOW },
  );
  await assert.rejects(() => adapter.connect({
    agentName: "@impostor",
    signal: new AbortController().signal,
    onWake() {},
    onError() {},
    onStateChange() {},
  }));
  assert.equal(mcp.calls.length, 0);
});
