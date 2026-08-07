import {
  type RacpAdapter,
  type RacpAdapterConnectInput,
  type RacpAgentDescription,
  type RacpMessageCursor,
  type RacpPersistMessageInput,
  type RacpStoredMessage,
  type RacpTaskRecord,
} from "@rnby/racp-client";

/**
 * Minimal single-process adapter for tests and prototypes.
 *
 * A production adapter should replace these Maps with durable storage, enforce
 * tenant/identity authorization before every operation, and use its event bus
 * only as a wake signal. listMessages() remains the source of message truth.
 */
export class LocalMemoryAdapter implements RacpAdapter {
  private readonly agents = new Map<string, RacpAgentDescription>();
  private readonly messages = new Map<string, RacpStoredMessage>();
  private readonly recipients = new Map<string, string>();
  private readonly tasks = new Map<string, RacpTaskRecord>();
  private readonly wakes = new Map<string, Set<() => void | Promise<void>>>();

  constructor(agents: readonly RacpAgentDescription[]) {
    for (const agent of agents) this.agents.set(agent.name, agent);
  }

  async connect(input: RacpAdapterConnectInput) {
    const handlers = this.wakes.get(input.agentName) ?? new Set();
    const wake = input.onWake;
    handlers.add(wake);
    this.wakes.set(input.agentName, handlers);
    input.onStateChange("connected");
    return {
      close: async () => {
        handlers.delete(wake);
      },
    };
  }

  async discover(input: Parameters<RacpAdapter["discover"]>[0]) {
    return [...this.agents.values()]
      .filter((agent) => !input.name || agent.name === input.name)
      .filter((agent) => !input.status || agent.status === input.status)
      .slice(0, input.limit ?? 50);
  }

  async listMessages(input: {
    toAgent: string;
    cursor: RacpMessageCursor | null;
    limit: number;
  }) {
    const ordered = [...this.messages.values()]
      .filter(
        (message) =>
          message.deliveryStatus === "queued" &&
          message.envelope &&
          message.id > (input.cursor?.messageId ?? "") &&
          this.recipients.get(message.id) === input.toAgent,
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, input.limit);
    return { messages: ordered, nextCursor: null };
  }

  async persistMessage(input: RacpPersistMessageInput) {
    const id = crypto.randomUUID();
    const createdAt = new Date(Number(input.sentAtMillis)).toISOString();
    this.messages.set(id, {
      id,
      envelope: input.envelope.slice(),
      createdAt,
      idempotencyKey: input.idempotencyKey,
      replyToMessageId: input.replyToMessageId,
      deliveryStatus: "queued",
      metadata: input.metadata,
    });
    this.recipients.set(id, input.toAgent);
    for (const wake of this.wakes.get(input.toAgent) ?? []) await wake();
    return { id, createdAt, deliveryStatus: "queued" as const };
  }

  async markDelivered(messageId: string) {
    this.setDelivery(messageId, "delivered");
  }

  async markFailed(messageId: string) {
    this.setDelivery(messageId, "failed");
  }

  async acknowledge(messageId: string) {
    this.setDelivery(messageId, "acknowledged");
  }

  async createTask(input: Parameters<RacpAdapter["createTask"]>[0]) {
    const now = new Date().toISOString();
    const task: RacpTaskRecord = {
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

  async updateTask(input: Parameters<RacpAdapter["updateTask"]>[0]) {
    const current = this.tasks.get(input.taskId);
    if (!current) throw new Error("Task not found.");
    const updated: RacpTaskRecord = {
      ...current,
      status: input.status,
      artifacts: input.artifacts ?? current.artifacts,
      metadata: input.metadata ?? current.metadata,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(updated.id, updated);
    return updated;
  }

  private setDelivery(
    id: string,
    deliveryStatus: RacpStoredMessage["deliveryStatus"],
  ) {
    const message = this.messages.get(id);
    if (message) this.messages.set(id, { ...message, deliveryStatus });
  }
}
