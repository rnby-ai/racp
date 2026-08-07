import assert from "node:assert/strict";
import test from "node:test";
import {
  RacpClient,
  racp_discover,
  racp_query,
  racp_task_create,
} from "@rnby/racp-client";

class MemoryAdapter {
  agents = [
    {
      name: "@planner",
      status: "online",
      capabilities: { "planning.breakdown": true },
    },
    {
      name: "@reviewer",
      status: "online",
      capabilities: { functions: ["code.review"] },
    },
  ];
  connections = new Map();
  messages = new Map();
  tasks = new Map();

  async connect(input) {
    this.connections.set(input.agentName, input);
    input.onStateChange("connected");
    return { close: async () => this.connections.delete(input.agentName) };
  }

  async discover(input) {
    return this.agents
      .filter((agent) => !input.name || agent.name === input.name)
      .filter((agent) => !input.status || agent.status === input.status);
  }

  async listMessages(input) {
    return {
      messages: [...this.messages.values()].filter(
        (message) =>
          message.toAgent === input.toAgent && message.deliveryStatus === "queued",
      ),
      nextCursor: null,
    };
  }

  async persistMessage(input) {
    const id = crypto.randomUUID();
    const createdAt = new Date(Number(input.sentAtMillis)).toISOString();
    this.messages.set(id, {
      id,
      toAgent: input.toAgent,
      envelope: input.envelope,
      createdAt,
      idempotencyKey: input.idempotencyKey,
      replyToMessageId: input.replyToMessageId,
      deliveryStatus: "queued",
      metadata: input.metadata,
    });
    await this.connections.get(input.toAgent)?.onWake();
    return { id, createdAt, deliveryStatus: "queued" };
  }

  async markDelivered(id) {
    this.messages.get(id).deliveryStatus = "delivered";
  }

  async markFailed(id) {
    this.messages.get(id).deliveryStatus = "failed";
  }

  async acknowledge(id) {
    this.messages.get(id).deliveryStatus = "acknowledged";
  }

  async createTask(input) {
    const now = new Date().toISOString();
    const task = {
      id: input.id,
      createdByAgent: input.createdByAgent,
      assignedToAgent: input.assignedToAgent,
      status: "created",
      artifacts: [],
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  async updateTask(input) {
    const task = this.tasks.get(input.taskId);
    Object.assign(task, {
      status: input.status,
      artifacts: input.artifacts ?? task.artifacts,
      metadata: input.metadata ?? task.metadata,
      updatedAt: new Date().toISOString(),
    });
    return task;
  }
}

test("programmatic clients discover, capability-route, task, and exchange events", async () => {
  const adapter = new MemoryAdapter();
  const planner = new RacpClient({ agentName: "@planner", adapter });
  const reviewer = new RacpClient({ agentName: "@reviewer", adapter });
  const received = [];
  reviewer.onMessage((message) => {
    received.push(message);
    return "acknowledged";
  });
  await Promise.all([planner.start(), reviewer.start()]);

  const discovered = await racp_discover(planner, { capability: "code.review" });
  assert.deepEqual(discovered.map((agent) => agent.name), ["@reviewer"]);

  const task = await racp_task_create(planner, {
    capability: "code.review",
    metadata: { objective: "Review public SDK" },
  });
  assert.equal(task.assignedToAgent, "@reviewer");

  const receipt = await racp_query(planner, {
    capability: "code.review",
    taskId: task.id,
    payload: new TextEncoder().encode("Please review."),
  });
  assert.equal(receipt.deliveryStatus, "queued");
  assert.equal(received.length, 1);
  assert.equal(received[0].fromAgent, "@planner");
  assert.equal(received[0].taskId, task.id);
  assert.equal(new TextDecoder().decode(received[0].payload), "Please review.");
  assert.equal(adapter.messages.get(receipt.id).deliveryStatus, "acknowledged");
  await Promise.all([planner.stop(), reviewer.stop()]);
});

test("a stopped pending connection closes before a fresh start", async () => {
  const adapter = new MemoryAdapter();
  let releaseFirst;
  let connects = 0;
  let closes = 0;
  adapter.connect = async (input) => {
    connects += 1;
    if (connects === 1) {
      await new Promise((resolve) => { releaseFirst = resolve; });
    }
    input.onStateChange("connected");
    return { close: async () => { closes += 1; } };
  };
  const client = new RacpClient({ agentName: "@planner", adapter });
  const firstStart = client.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stopping = client.stop();
  releaseFirst();
  await Promise.all([firstStart, stopping]);
  assert.equal(client.state, "stopped");
  assert.equal(connects, 1);
  assert.equal(closes, 1);

  await client.start();
  assert.equal(client.state, "connected");
  assert.equal(connects, 2);
  await client.stop();
  assert.equal(closes, 2);
});

test("a fresh start waits for a slow stop and degraded start is idempotent", async () => {
  const adapter = new MemoryAdapter();
  let releaseClose;
  let connects = 0;
  let currentInput;
  adapter.connect = async (input) => {
    connects += 1;
    currentInput = input;
    input.onStateChange("connected");
    return {
      close: async () => {
        if (connects === 1) {
          await new Promise((resolve) => { releaseClose = resolve; });
        }
      },
    };
  };
  const client = new RacpClient({ agentName: "@planner", adapter });
  await client.start();
  assert.equal(client.state, "connected");
  currentInput.onStateChange("degraded");
  await client.start();
  assert.equal(connects, 1);
  assert.equal(client.state, "degraded");

  const stopping = client.stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const restarting = client.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(connects, 1);
  releaseClose();
  await Promise.all([stopping, restarting]);
  assert.equal(connects, 2);
  assert.equal(client.state, "connected");
  await client.stop();
});
