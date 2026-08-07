import {
  RACP_INTENT_CODES,
  RACP_PROTOCOL_VERSION,
  intentCodeForName,
  pack,
  tryUnpack,
  type RacpByteSource,
  type RacpIntentCode,
  type RacpIntentName,
  type RacpTimestampMillis,
  type RacpV1Envelope,
} from "@rnby/racp-codec";
import {
  assertCausalTaskEvent,
  type RacpTaskEvent,
  type RacpTaskEventCursor,
  type RacpTaskEventPage,
  type RacpTaskEventSource,
} from "./task-events.js";

export {
  RACP_TASK_STATUSES,
  RacpMcpTaskEventSource,
  assertCausalTaskEvent,
  parseTaskEvent,
  parseTaskEventPage,
} from "./task-events.js";
export type {
  RacpTaskEvent,
  RacpTaskEventCursor,
  RacpTaskEventFetchInput,
  RacpTaskEventJson,
  RacpTaskEventMcpCaller,
  RacpTaskEventPage,
  RacpTaskEventSource,
  RacpTaskStatus,
} from "./task-events.js";

const AGENT_NAME_PATTERN = /^@[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RacpJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly RacpJsonValue[]
  | Readonly<{ [key: string]: RacpJsonValue }>;

export type RacpClientState =
  | "stopped"
  | "connecting"
  | "connected"
  | "degraded"
  | "stopping";

export type RacpAdapterState = "connected" | "degraded";

export type RacpClientErrorCode =
  | "invalid_input"
  | "not_connected"
  | "adapter_error"
  | "decode_error"
  | "routing_error";

export class RacpClientError extends Error {
  readonly code: RacpClientErrorCode;
  readonly retryable: boolean;
  readonly messageId: string | undefined;
  declare readonly cause?: unknown;

  constructor(
    code: RacpClientErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      cause?: unknown;
      messageId?: string;
    } = {},
  ) {
    super(message);
    this.name = "RacpClientError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.messageId = options.messageId;
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: options.cause,
      });
    }
  }
}

export interface RacpAgentDescription {
  name: string;
  status: "online" | "offline" | "unknown";
  capabilities: Readonly<Record<string, RacpJsonValue>>;
  machine?: string;
  metadata?: Readonly<Record<string, RacpJsonValue>>;
}

export interface RacpDiscoverInput {
  name?: string;
  status?: "online" | "offline";
  capability?: string;
  limit?: number;
}

export interface RacpTaskRecord {
  id: string;
  createdByAgent: string;
  assignedToAgent: string;
  status: "created" | "working" | "completed" | "failed" | "aborted";
  artifacts: readonly RacpJsonValue[];
  metadata: Readonly<Record<string, RacpJsonValue>>;
  createdAt: string;
  updatedAt: string;
}

export interface RacpTaskCreateAdapterInput {
  id: string;
  createdByAgent: string;
  assignedToAgent: string;
  metadata: Readonly<Record<string, RacpJsonValue>>;
}

export interface RacpTaskUpdateAdapterInput {
  taskId: string;
  actingAgent: string;
  status: "working" | "completed" | "failed" | "aborted";
  artifacts?: readonly RacpJsonValue[];
  metadata?: Readonly<Record<string, RacpJsonValue>>;
}

export interface RacpStoredMessage {
  id: string;
  envelope: RacpByteSource;
  createdAt: string;
  idempotencyKey: string;
  replyToMessageId: string | null;
  deliveryStatus: "queued" | "delivered" | "acknowledged" | "failed";
  metadata: Readonly<Record<string, RacpJsonValue>>;
}

export interface RacpMessageCursor {
  createdAt: string;
  messageId: string;
}

export interface RacpMessagePage {
  messages: readonly RacpStoredMessage[];
  nextCursor: RacpMessageCursor | null;
}

export interface RacpPersistMessageInput {
  protocolVersion: typeof RACP_PROTOCOL_VERSION;
  intentCode: RacpIntentCode;
  fromAgent: string;
  toAgent: string;
  taskId: string | null;
  replyToMessageId: string | null;
  idempotencyKey: string;
  sentAtMillis: RacpTimestampMillis;
  payloadHash: Uint8Array;
  envelope: Uint8Array;
  metadata: Readonly<Record<string, RacpJsonValue>>;
}

export interface RacpPersistedMessage {
  id: string;
  createdAt: string;
  deliveryStatus: "queued" | "delivered" | "acknowledged" | "failed";
}

export interface RacpAdapterConnection {
  close(): Promise<void>;
}

export interface RacpAdapterConnectInput {
  agentName: string;
  signal: AbortSignal;
  onWake(): void | Promise<void>;
  onError(error: unknown): void;
  onStateChange(state: RacpAdapterState): void;
}

/**
 * Hosting-neutral boundary. Implement this interface for a database, queue,
 * local socket, hosted MCP service, or another durable transport.
 */
export interface RacpAdapter {
  connect(input: RacpAdapterConnectInput): Promise<RacpAdapterConnection>;
  discover(
    input: RacpDiscoverInput,
    signal: AbortSignal,
  ): Promise<readonly RacpAgentDescription[]>;
  /** Optional authoritative server-side capability router. */
  routeCapability?(
    input: RacpRouteInput,
    signal: AbortSignal,
  ): Promise<RacpAgentDescription>;
  listMessages(
    input: {
      toAgent: string;
      cursor: RacpMessageCursor | null;
      limit: number;
    },
    signal: AbortSignal,
  ): Promise<RacpMessagePage>;
  persistMessage(
    input: RacpPersistMessageInput,
    signal: AbortSignal,
  ): Promise<RacpPersistedMessage>;
  markDelivered(messageId: string, signal: AbortSignal): Promise<void>;
  markFailed(messageId: string, signal: AbortSignal): Promise<void>;
  acknowledge(messageId: string, signal: AbortSignal): Promise<void>;
  createTask(
    input: RacpTaskCreateAdapterInput,
    signal: AbortSignal,
  ): Promise<RacpTaskRecord>;
  updateTask(
    input: RacpTaskUpdateAdapterInput,
    signal: AbortSignal,
  ): Promise<RacpTaskRecord>;
}

export interface RacpIncomingMessage extends RacpV1Envelope {
  messageId: string;
  receivedAt: string;
  idempotencyKey: string;
  replyToMessageId: string | null;
  deliveryStatus: RacpStoredMessage["deliveryStatus"];
  metadata: Readonly<Record<string, RacpJsonValue>>;
}

export type RacpIntent =
  | RacpIntentCode
  | RacpIntentName
  | Lowercase<RacpIntentName>;

export interface RacpSendInput {
  toAgent?: string;
  capability?: string;
  intent: RacpIntent;
  payload: RacpByteSource;
  idempotencyKey?: string;
  taskId?: string | null;
  replyToMessageId?: string | null;
  sentAtMillis?: RacpTimestampMillis;
  metadata?: Readonly<Record<string, RacpJsonValue>>;
}

export type RacpQueryInput = Omit<RacpSendInput, "intent">;

export interface RacpTaskCreateInput {
  taskId?: string;
  assignedToAgent?: string;
  capability?: string;
  metadata?: Readonly<Record<string, RacpJsonValue>>;
}

export interface RacpRouteInput {
  capability: string;
  status?: "online" | "offline";
}

export type RacpMessageDisposition = "delivered" | "acknowledged" | "retry";
export type RacpMessageHandler = (
  message: RacpIncomingMessage,
) =>
  | void
  | boolean
  | RacpMessageDisposition
  | Promise<void | boolean | RacpMessageDisposition>;
export type RacpTaskUpdateHandler = (
  event: RacpTaskEvent,
) => void | boolean | Promise<void | boolean>;
export type RacpErrorHandler = (error: RacpClientError) => void;
export type RacpStateHandler = (state: RacpClientState) => void;

export interface RacpClientOptions {
  agentName: string;
  adapter: RacpAdapter;
  now?: () => number;
  createId?: () => string;
  drainPageSize?: number;
  taskEventSource?: RacpTaskEventSource;
  taskEventPollMs?: number;
  taskEventPageSize?: number;
}

/** Event-driven public client; no CLI process is required. */
export class RacpClient {
  readonly agentName: string;
  private readonly adapter: RacpAdapter;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly drainPageSize: number;
  private readonly taskEventSource: RacpTaskEventSource | null;
  private readonly taskEventPollMs: number;
  private readonly taskEventPageSize: number;
  private readonly messageHandlers = new Set<RacpMessageHandler>();
  private readonly taskEventHandlers = new Set<RacpTaskUpdateHandler>();
  private readonly errorHandlers = new Set<RacpErrorHandler>();
  private readonly stateHandlers = new Set<RacpStateHandler>();
  private currentState: RacpClientState = "stopped";
  private controller: AbortController | null = null;
  private connection: RacpAdapterConnection | null = null;
  private generation = 0;
  private startPromise: Promise<void> | null = null;
  private startGeneration = 0;
  private stopPromise: Promise<void> | null = null;
  private drainPromise: Promise<void> | null = null;
  private drainGeneration = 0;
  private drainRequested = false;
  private inboxRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private taskEventTimer: ReturnType<typeof setTimeout> | null = null;
  private taskEventDrainPromise: Promise<void> | null = null;
  private taskEventDrainGeneration = 0;
  private taskEventDrainRequested = false;
  private taskEventCursor: RacpTaskEventCursor | null = null;
  private readonly taskSequences = new Map<string, number>();
  private readonly taskEventIds = new Map<string, string>();

  constructor(options: RacpClientOptions) {
    assertAgentName(options.agentName, "agentName");
    this.agentName = options.agentName;
    this.adapter = options.adapter;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? defaultCreateId;
    this.drainPageSize = boundedLimit(options.drainPageSize ?? 100, 1, 250);
    this.taskEventSource = options.taskEventSource ?? null;
    this.taskEventPollMs = boundedDuration(
      options.taskEventPollMs ?? 5_000,
      100,
      60_000,
      "taskEventPollMs",
    );
    this.taskEventPageSize = boundedLimit(
      options.taskEventPageSize ?? 100,
      1,
      250,
    );
  }

  get state(): RacpClientState {
    return this.currentState;
  }

  onMessage(handler: RacpMessageHandler): () => void {
    this.messageHandlers.add(handler);
    const signal = this.controller?.signal;
    if (
      signal &&
      !signal.aborted &&
      (this.state === "connected" || this.state === "degraded")
    ) {
      void this.requestDrain(this.generation, signal);
    }
    return () => this.messageHandlers.delete(handler);
  }

  /**
   * Subscribe to durable task transitions in global event_position order.
   * Returning false or throwing leaves the cursor unchanged for retry.
   */
  onTaskUpdate(handler: RacpTaskUpdateHandler): () => void {
    if (!this.taskEventSource) {
      throw new RacpClientError(
        "invalid_input",
        "RACP task updates require a taskEventSource.",
      );
    }
    this.taskEventHandlers.add(handler);
    const signal = this.controller?.signal;
    if (signal && !signal.aborted && this.isActive()) {
      void this.requestTaskEventDrain(this.generation, signal);
      this.scheduleTaskEventPoll(this.generation, signal);
    }
    return () => {
      this.taskEventHandlers.delete(handler);
      if (this.taskEventHandlers.size === 0) this.clearTaskEventTimer();
    };
  }

  onError(handler: RacpErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  onStateChange(handler: RacpStateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  async start(): Promise<void> {
    if (this.stopPromise) await this.stopPromise;
    if (this.startPromise) {
      const pending = this.startPromise;
      const pendingGeneration = this.startGeneration;
      try {
        await pending;
      } catch (cause) {
        if (this.generation === pendingGeneration) throw cause;
      }
      if (this.state === "connected") return;
      if (this.startPromise === pending) this.startPromise = null;
      if (this.startPromise) return this.start();
    }
    if (this.state === "connected" || this.state === "degraded") return;
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.setState("connecting");

    const operation = (async () => {
      try {
        const connection = await this.adapter.connect({
          agentName: this.agentName,
          signal: controller.signal,
          onWake: () => {
            if (this.isCurrent(generation, controller.signal)) {
              return this.requestDrain(generation, controller.signal);
            }
          },
          onError: (error) => {
            if (!this.isCurrent(generation, controller.signal)) return;
            this.setState("degraded");
            this.emitError(adapterError(error));
          },
          onStateChange: (state) => {
            if (!this.isCurrent(generation, controller.signal)) return;
            this.setState(state);
            if (state === "connected") {
              void this.requestDrain(generation, controller.signal);
              void this.requestTaskEventDrain(generation, controller.signal);
              this.scheduleTaskEventPoll(generation, controller.signal);
            }
          },
        });
        if (!this.isCurrent(generation, controller.signal)) {
          await connection.close();
          return;
        }
        this.connection = connection;
        this.setState("connected");
        await this.requestDrain(generation, controller.signal);
        await this.requestTaskEventDrain(generation, controller.signal);
        this.scheduleTaskEventPoll(generation, controller.signal);
      } catch (cause) {
        if (!this.isCurrent(generation, controller.signal)) return;
        const error = adapterError(cause, "RACP adapter could not connect.");
        controller.abort();
        this.controller = null;
        this.connection = null;
        this.setState("stopped");
        this.emitError(error);
        throw error;
      }
    })();
    this.startPromise = operation;
    this.startGeneration = generation;
    try {
      await operation;
    } finally {
      if (this.startPromise === operation) {
        this.startPromise = null;
        this.startGeneration = 0;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.state === "stopped" && !this.startPromise) return;
    const generation = ++this.generation;
    this.setState("stopping");
    this.controller?.abort();
    this.controller = null;
    this.drainRequested = false;
    this.taskEventDrainRequested = false;
    this.clearInboxRetryTimer();
    this.clearTaskEventTimer();
    const pendingStart = this.startPromise;
    const connection = this.connection;
    this.connection = null;
    const operation = (async () => {
      try {
        await pendingStart?.catch(() => undefined);
        await connection?.close();
      } catch (cause) {
        this.emitError(
          adapterError(cause, "RACP adapter did not close cleanly."),
        );
      } finally {
        if (this.generation === generation) this.setState("stopped");
      }
    })();
    this.stopPromise = operation;
    try {
      await operation;
    } finally {
      if (this.stopPromise === operation) this.stopPromise = null;
    }
  }

  async discover(input: RacpDiscoverInput = {}) {
    const signal = this.requireConnected();
    if (input.name !== undefined) assertAgentName(input.name, "name");
    if (input.capability !== undefined) assertCapability(input.capability);
    const limit = boundedLimit(input.limit ?? 50, 1, 100);
    const agents = await this.adapter.discover({ ...input, limit }, signal);
    return [...agents]
      .filter((agent) => {
        assertAgentName(agent.name, "discovered agent name");
        return !input.capability || supportsCapability(agent, input.capability);
      })
      .sort(compareAgents)
      .slice(0, limit);
  }

  async routeCapability(input: RacpRouteInput): Promise<RacpAgentDescription> {
    assertCapability(input.capability);
    const signal = this.requireConnected();
    if (this.adapter.routeCapability) {
      try {
        const selected = await this.adapter.routeCapability(input, signal);
        assertAgentName(selected.name, "routed agent name");
        return selected;
      } catch (cause) {
        throw new RacpClientError(
          "routing_error",
          `No RACP agent advertises capability ${input.capability}.`,
          { retryable: true, cause },
        );
      }
    }
    const candidates = await this.discover({
      capability: input.capability,
      ...(input.status ? { status: input.status } : {}),
      limit: 100,
    });
    const candidate = candidates[0];
    if (!candidate) {
      throw new RacpClientError(
        "routing_error",
        `No RACP agent advertises capability ${input.capability}.`,
        { retryable: true },
      );
    }
    return candidate;
  }

  async send(input: RacpSendInput): Promise<RacpPersistedMessage> {
    const signal = this.requireConnected();
    const toAgent = await this.resolveTarget(input.toAgent, input.capability);
    const intentCode = normalizeIntent(input.intent);
    const idempotencyKey = input.idempotencyKey ?? `racp-${this.createId()}`;
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new RacpClientError(
        "invalid_input",
        "RACP idempotencyKey must contain 1..128 characters.",
      );
    }
    validateOptionalUuid(input.taskId, "taskId");
    validateOptionalUuid(input.replyToMessageId, "replyToMessageId");
    const sentAtMillis = input.sentAtMillis ?? this.now();
    const packed = await pack({
      intentCode,
      fromAgent: this.agentName,
      toAgent,
      taskId: input.taskId ?? null,
      sentAtMillis,
      payload: input.payload,
    });
    try {
      return await this.adapter.persistMessage(
        {
          protocolVersion: RACP_PROTOCOL_VERSION,
          intentCode,
          fromAgent: this.agentName,
          toAgent,
          taskId: input.taskId ?? null,
          replyToMessageId: input.replyToMessageId ?? null,
          idempotencyKey,
          sentAtMillis,
          payloadHash: packed.payloadHash,
          envelope: packed.envelope,
          metadata: input.metadata ?? {},
        },
        signal,
      );
    } catch (cause) {
      const error = adapterError(
        cause,
        "RACP adapter could not persist the outbound message.",
      );
      this.emitError(error);
      throw error;
    }
  }

  query(input: RacpQueryInput): Promise<RacpPersistedMessage> {
    return this.send({ ...input, intent: RACP_INTENT_CODES.QUERY });
  }

  async taskCreate(input: RacpTaskCreateInput): Promise<RacpTaskRecord> {
    const signal = this.requireConnected();
    const taskId = input.taskId ?? this.createId();
    validateUuid(taskId, "taskId");
    const assignedToAgent = await this.resolveTarget(
      input.assignedToAgent,
      input.capability,
    );
    try {
      return await this.adapter.createTask(
        {
          id: taskId,
          createdByAgent: this.agentName,
          assignedToAgent,
          metadata: input.metadata ?? {},
        },
        signal,
      );
    } catch (cause) {
      throw adapterError(cause, "RACP adapter could not create the task.");
    }
  }

  async taskUpdate(
    input: Omit<RacpTaskUpdateAdapterInput, "actingAgent">,
  ): Promise<RacpTaskRecord> {
    const signal = this.requireConnected();
    validateUuid(input.taskId, "taskId");
    try {
      return await this.adapter.updateTask(
        { ...input, actingAgent: this.agentName },
        signal,
      );
    } catch (cause) {
      throw adapterError(cause, "RACP adapter could not update the task.");
    }
  }

  async acknowledge(messageId: string): Promise<void> {
    const signal = this.requireConnected();
    validateUuid(messageId, "messageId");
    try {
      await this.adapter.acknowledge(messageId, signal);
    } catch (cause) {
      throw adapterError(cause, "RACP adapter could not acknowledge the message.");
    }
  }

  private async resolveTarget(
    explicitAgent: string | undefined,
    capability: string | undefined,
  ): Promise<string> {
    if (explicitAgent && capability) {
      throw new RacpClientError(
        "invalid_input",
        "Provide toAgent/assignedToAgent or capability, not both.",
      );
    }
    if (explicitAgent) {
      assertAgentName(explicitAgent, "target agent");
      return explicitAgent;
    }
    if (capability) {
      return (await this.routeCapability({ capability, status: "online" })).name;
    }
    throw new RacpClientError(
      "invalid_input",
      "A target agent or capability is required.",
    );
  }

  private requireConnected(): AbortSignal {
    const signal = this.controller?.signal;
    if (
      !signal ||
      signal.aborted ||
      (this.state !== "connected" && this.state !== "degraded")
    ) {
      throw new RacpClientError(
        "not_connected",
        "RACP client is not connected.",
        { retryable: true },
      );
    }
    return signal;
  }

  private requestDrain(generation: number, signal: AbortSignal): Promise<void> {
    this.drainRequested = true;
    if (this.drainPromise) {
      if (this.drainGeneration === generation) return this.drainPromise;
      const prior = this.drainPromise;
      return prior.catch(() => undefined).then(() =>
        this.requestDrain(generation, signal),
      );
    }
    this.drainGeneration = generation;
    const operation = (async () => {
      while (this.drainRequested && this.isCurrent(generation, signal)) {
        this.drainRequested = false;
        const retry = await this.drainOnce(generation, signal);
        if (retry) this.scheduleInboxRetry(generation, signal);
      }
    })();
    this.drainPromise = operation;
    const finalize = () => {
      if (this.drainPromise === operation) {
        this.drainPromise = null;
        this.drainGeneration = 0;
      }
      if (this.drainRequested && this.isCurrent(generation, signal)) {
        void this.requestDrain(generation, signal);
      }
    };
    void operation.then(finalize, finalize);
    return operation;
  }

  private requestTaskEventDrain(
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.taskEventSource || this.taskEventHandlers.size === 0) {
      return Promise.resolve();
    }
    this.taskEventDrainRequested = true;
    if (this.taskEventDrainPromise) {
      if (this.taskEventDrainGeneration === generation) {
        return this.taskEventDrainPromise;
      }
      const prior = this.taskEventDrainPromise;
      return prior.catch(() => undefined).then(() =>
        this.requestTaskEventDrain(generation, signal),
      );
    }

    this.taskEventDrainGeneration = generation;
    const operation = (async () => {
      while (
        this.taskEventDrainRequested &&
        this.isCurrent(generation, signal)
      ) {
        this.taskEventDrainRequested = false;
        try {
          await this.drainTaskEvents(generation, signal);
        } catch (cause) {
          if (this.isCurrent(generation, signal)) {
            this.emitError(
              new RacpClientError(
                "adapter_error",
                "RACP could not deliver durable task updates.",
                { retryable: true, cause },
              ),
            );
          }
          return;
        }
      }
    })();
    this.taskEventDrainPromise = operation;
    const finalize = () => {
      if (this.taskEventDrainPromise === operation) {
        this.taskEventDrainPromise = null;
        this.taskEventDrainGeneration = 0;
      }
      if (this.taskEventDrainRequested && this.isCurrent(generation, signal)) {
        void this.requestTaskEventDrain(generation, signal);
      }
    };
    void operation.then(finalize, finalize);
    return operation;
  }

  private async drainTaskEvents(
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const source = this.taskEventSource;
    if (!source || this.taskEventHandlers.size === 0) return;
    let hasMore: boolean;
    do {
      const page = await source.fetchTaskEvents({
        agentName: this.agentName,
        cursor: this.taskEventCursor,
        limit: this.taskEventPageSize,
        signal,
      });
      this.assertTaskEventPage(page);
      hasMore = page.hasMore;

      for (const event of page.events) {
        if (!this.isCurrent(generation, signal)) return;
        const priorCursor = this.taskEventCursor?.position ?? 0;
        if (event.position <= priorCursor) {
          throw new TypeError(
            "RACP task-event source replayed an accepted cursor.",
          );
        }
        assertCausalTaskEvent(
          event,
          this.taskSequences.get(event.taskId),
          this.taskEventIds.get(event.taskId),
        );

        for (const handler of Array.from(this.taskEventHandlers)) {
          if ((await handler(event)) === false) {
            throw new Error("RACP task update was not accepted by its handler.");
          }
          if (!this.isCurrent(generation, signal)) return;
        }

        if (!this.isCurrent(generation, signal)) return;
        this.taskSequences.set(event.taskId, event.sequence);
        this.taskEventIds.set(event.taskId, event.id);
        this.taskEventCursor = { position: event.position };
      }
    } while (
      hasMore &&
      this.isCurrent(generation, signal) &&
      this.taskEventHandlers.size > 0
    );
  }

  private assertTaskEventPage(page: RacpTaskEventPage): void {
    const events = page.events;
    if (!Array.isArray(events) || typeof page.hasMore !== "boolean") {
      throw new TypeError("RACP task-event source returned an invalid page.");
    }
    if (events.length === 0) {
      if (page.hasMore || page.nextCursor !== null) {
        throw new TypeError("RACP task-event source did not advance its cursor.");
      }
      return;
    }
    let position = this.taskEventCursor?.position ?? 0;
    for (const event of events) {
      if (!Number.isSafeInteger(event.position) || event.position <= position) {
        throw new TypeError("RACP task-event source was not strictly ordered.");
      }
      position = event.position;
    }
    if (page.nextCursor?.position !== position) {
      throw new TypeError("RACP task-event source returned a mismatched cursor.");
    }
  }

  private scheduleTaskEventPoll(
    generation: number,
    signal: AbortSignal,
  ): void {
    if (
      this.taskEventTimer ||
      !this.taskEventSource ||
      this.taskEventHandlers.size === 0 ||
      !this.isCurrent(generation, signal)
    ) {
      return;
    }
    this.taskEventTimer = setTimeout(() => {
      this.taskEventTimer = null;
      void this.requestTaskEventDrain(generation, signal).finally(() => {
        this.scheduleTaskEventPoll(generation, signal);
      });
    }, this.taskEventPollMs);
  }

  private clearTaskEventTimer(): void {
    if (!this.taskEventTimer) return;
    clearTimeout(this.taskEventTimer);
    this.taskEventTimer = null;
  }

  private scheduleInboxRetry(generation: number, signal: AbortSignal): void {
    if (this.inboxRetryTimer || !this.isCurrent(generation, signal)) return;
    this.inboxRetryTimer = setTimeout(() => {
      this.inboxRetryTimer = null;
      void this.requestDrain(generation, signal);
    }, 1_000);
  }

  private clearInboxRetryTimer(): void {
    if (!this.inboxRetryTimer) return;
    clearTimeout(this.inboxRetryTimer);
    this.inboxRetryTimer = null;
  }

  private isActive(): boolean {
    return this.state === "connected" || this.state === "degraded";
  }

  private async drainOnce(
    generation: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.messageHandlers.size === 0) return false;
    let retryNeeded = false;
    let cursor: RacpMessageCursor | null = null;
    const seen = new Set<string>();
    do {
      let page: RacpMessagePage;
      try {
        page = await this.adapter.listMessages(
          { toAgent: this.agentName, cursor, limit: this.drainPageSize },
          signal,
        );
      } catch (cause) {
        this.emitError(adapterError(cause, "RACP adapter could not drain the inbox."));
        return true;
      }

      for (const row of page.messages) {
        if (!this.isCurrent(generation, signal)) return retryNeeded;
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        const decoded = await tryUnpack(row.envelope);
        if (!decoded.ok || decoded.envelope.toAgent !== this.agentName) {
          const error = new RacpClientError(
            "decode_error",
            "RACP received an invalid or misrouted durable envelope.",
            { messageId: row.id },
          );
          this.emitError(error);
          try {
            await this.adapter.markFailed(row.id, signal);
          } catch (cause) {
            retryNeeded = true;
            this.emitError(adapterError(cause, "RACP could not quarantine a message."));
          }
          continue;
        }

        const message: RacpIncomingMessage = {
          ...decoded.envelope,
          messageId: row.id,
          receivedAt: row.createdAt,
          idempotencyKey: row.idempotencyKey,
          replyToMessageId: row.replyToMessageId,
          deliveryStatus: row.deliveryStatus,
          metadata: row.metadata,
        };
        let accepted = true;
        let acknowledge = false;
        for (const handler of this.messageHandlers) {
          try {
            const disposition = await handler(message);
            if (disposition === false || disposition === "retry") accepted = false;
            if (disposition === "acknowledged") acknowledge = true;
          } catch (cause) {
            accepted = false;
            this.emitError(
              new RacpClientError(
                "adapter_error",
                "RACP message handling did not complete.",
                { retryable: true, cause, messageId: row.id },
              ),
            );
          }
        }
        if (!accepted) retryNeeded = true;
        if (accepted && this.isCurrent(generation, signal)) {
          try {
            if (acknowledge) await this.adapter.acknowledge(row.id, signal);
            else await this.adapter.markDelivered(row.id, signal);
          } catch (cause) {
            retryNeeded = true;
            this.emitError(
              adapterError(cause, "RACP could not record message delivery."),
            );
          }
        }
      }

      if (
        cursor &&
        page.nextCursor &&
        cursor.createdAt === page.nextCursor.createdAt &&
        cursor.messageId === page.nextCursor.messageId
      ) {
        this.emitError(
          new RacpClientError(
            "adapter_error",
            "RACP inbox pagination did not advance.",
            { retryable: true },
          ),
        );
        return retryNeeded;
      }
      cursor = page.nextCursor;
    } while (cursor && this.isCurrent(generation, signal));
    return retryNeeded;
  }

  private isCurrent(generation: number, signal: AbortSignal): boolean {
    return generation === this.generation && !signal.aborted;
  }

  private setState(state: RacpClientState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    for (const handler of this.stateHandlers) {
      try {
        handler(state);
      } catch {
        // Observers never control lifecycle state.
      }
    }
  }

  private emitError(error: RacpClientError): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch {
        // Error observers remain isolated.
      }
    }
  }
}

export function racp_send(
  client: RacpClient,
  input: RacpSendInput,
): Promise<RacpPersistedMessage> {
  return client.send(input);
}

export function racp_query(
  client: RacpClient,
  input: RacpQueryInput,
): Promise<RacpPersistedMessage> {
  return client.query(input);
}

export function racp_discover(
  client: RacpClient,
  input: RacpDiscoverInput = {},
): Promise<RacpAgentDescription[]> {
  return client.discover(input);
}

export function racp_task_create(
  client: RacpClient,
  input: RacpTaskCreateInput,
): Promise<RacpTaskRecord> {
  return client.taskCreate(input);
}

export function supportsCapability(
  agent: RacpAgentDescription,
  capability: string,
): boolean {
  assertCapability(capability);
  const direct = agent.capabilities[capability];
  if (direct === true || typeof direct === "string" || typeof direct === "number") {
    return true;
  }
  const functions = agent.capabilities.functions;
  if (Array.isArray(functions) && functions.includes(capability)) return true;
  let current: RacpJsonValue | undefined = agent.capabilities;
  for (const segment of capability.split(".")) {
    if (!isJsonObject(current)) return false;
    current = current[segment];
  }
  return current === true || typeof current === "string" || typeof current === "number";
}

function normalizeIntent(intent: RacpIntent): RacpIntentCode {
  if (typeof intent === "number") {
    if (Object.values(RACP_INTENT_CODES).includes(intent as RacpIntentCode)) {
      return intent as RacpIntentCode;
    }
    throw new RacpClientError("invalid_input", "RACP intent code is not recognized.");
  }
  return intentCodeForName(intent);
}

function assertAgentName(value: string, label: string): void {
  if (!AGENT_NAME_PATTERN.test(value)) {
    throw new RacpClientError(
      "invalid_input",
      `${label} must be a canonical lowercase @agent name.`,
    );
  }
}

function assertCapability(value: string): void {
  if (!/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(value)) {
    throw new RacpClientError(
      "invalid_input",
      "RACP capability must be a nonempty stable identifier.",
    );
  }
}

function validateUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new RacpClientError(
      "invalid_input",
      `${label} must be a canonical non-nil UUID.`,
    );
  }
}

function validateOptionalUuid(value: string | null | undefined, label: string) {
  if (value !== undefined && value !== null) validateUuid(value, label);
}

function boundedLimit(value: number, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RacpClientError(
      "invalid_input",
      `RACP limit must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function boundedDuration(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RacpClientError(
      "invalid_input",
      `${label} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function compareAgents(left: RacpAgentDescription, right: RacpAgentDescription) {
  const rank = { online: 0, unknown: 1, offline: 2 } as const;
  return rank[left.status] - rank[right.status] || left.name.localeCompare(right.name);
}

function isJsonObject(
  value: RacpJsonValue | undefined,
): value is Readonly<Record<string, RacpJsonValue>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function defaultCreateId(): string {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) {
    throw new RacpClientError(
      "invalid_input",
      "Web Crypto randomUUID is required unless createId is supplied.",
    );
  }
  return id;
}

function adapterError(
  cause: unknown,
  message = "RACP adapter operation failed.",
): RacpClientError {
  if (cause instanceof RacpClientError) return cause;
  return new RacpClientError("adapter_error", message, {
    retryable: true,
    cause,
  });
}
