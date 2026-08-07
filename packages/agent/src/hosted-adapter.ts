import { createClient } from "@supabase/supabase-js";
import {
  base64ToBytes,
  bytesToBase64,
  tryUnpack,
  unpack,
} from "@rnby/racp-codec";
import type {
  RacpAdapter,
  RacpAdapterConnectInput,
  RacpAdapterConnection,
  RacpAgentDescription,
  RacpDiscoverInput,
  RacpJsonValue,
  RacpMessagePage,
  RacpPersistMessageInput,
  RacpPersistedMessage,
  RacpRouteInput,
  RacpStoredMessage,
  RacpTaskCreateAdapterInput,
  RacpTaskRecord,
  RacpTaskUpdateAdapterInput,
} from "@rnby/racp-client";
import { RacpMcpToolError, type RacpMcpClient } from "./mcp.js";

const AGENT_NAME_PATTERN = /^@[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const COMPACT_JWT_PATTERN =
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const JOIN_TIMEOUT_MS = 15_000;
const HEARTBEAT_LEAD_MS = 30_000;
const CREDENTIAL_TTL_MS = 90_000;

type RealtimeStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

interface RacpRealtimeChannelLike {
  on(
    type: "broadcast",
    filter: { event: "message" },
    callback: (payload: unknown) => void,
  ): RacpRealtimeChannelLike;
  subscribe(
    callback: (status: RealtimeStatus, error?: Error) => void,
  ): RacpRealtimeChannelLike;
  track(payload: Record<string, unknown>): Promise<"ok" | "timed out" | "error">;
  untrack(): Promise<"ok" | "timed out" | "error">;
}

interface RacpSupabaseClientLike {
  realtime: { setAuth(token?: string | null): Promise<void> };
  channel(
    topic: string,
    options: {
      config: {
        private: true;
        presence?: { key: string; enabled: true };
      };
    },
  ): RacpRealtimeChannelLike;
  removeChannel(channel: RacpRealtimeChannelLike): Promise<unknown> | unknown;
  rpc(
    name: "racp_set_agent_presence",
    args: { p_agent_name: string; p_online: boolean },
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

export type RacpSupabaseClientFactory = (
  url: string,
  anonKey: string,
  options: {
    accessToken: () => Promise<string | null>;
    auth: {
      autoRefreshToken: false;
      detectSessionInUrl: false;
      persistSession: false;
    };
  },
) => RacpSupabaseClientLike;

export interface RacpHostedMcpCaller {
  connect?(signal?: AbortSignal): Promise<void>;
  call<T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T>;
  close?(): Promise<void>;
}

export interface RacpHostedAdapterOptions {
  agentName: string;
  tenantSlug: string;
  machine: string;
  capabilities?: Readonly<Record<string, RacpJsonValue>>;
  mcp: RacpHostedMcpCaller | RacpMcpClient;
  heartbeatLeadMs?: number;
}

export interface RacpHostedAdapterDependencies {
  createSupabaseClient?: RacpSupabaseClientFactory;
  now?: () => number;
  createId?: () => string;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

interface TransportIssue {
  dataToken: string;
  realtimeToken: string;
  expiresAt: number;
  tenantId: string;
  tenantSlug: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

/** Concrete RnBy MCP + private Supabase Realtime public adapter. */
export class RacpHostedAdapter implements RacpAdapter {
  readonly agentName: string;
  private readonly tenantSlug: string;
  private readonly machine: string;
  private readonly capabilities: Readonly<Record<string, RacpJsonValue>>;
  private readonly mcp: RacpHostedMcpCaller;
  private readonly createSupabaseClient: RacpSupabaseClientFactory;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly heartbeatLeadMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private issue: TransportIssue | null = null;
  private dataClient: RacpSupabaseClientLike | null = null;
  private realtimeClient: RacpSupabaseClientLike | null = null;
  private messageChannel: RacpRealtimeChannelLike | null = null;
  private presenceChannel: RacpRealtimeChannelLike | null = null;
  private connectInput: RacpAdapterConnectInput | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private messageReady = false;
  private presenceReady = false;
  private connectedNotified = false;
  private readonly replacingChannels = new WeakSet<object>();
  private readonly activatingPresenceChannels = new WeakSet<object>();

  constructor(
    options: RacpHostedAdapterOptions,
    dependencies: RacpHostedAdapterDependencies = {},
  ) {
    assertAgentName(options.agentName);
    this.agentName = options.agentName;
    this.tenantSlug = boundedSlug(options.tenantSlug);
    this.machine = boundedText(options.machine, "machine", 255);
    this.capabilities = options.capabilities ?? {};
    this.mcp = options.mcp;
    this.createSupabaseClient =
      dependencies.createSupabaseClient ?? defaultSupabaseClientFactory;
    this.now = dependencies.now ?? Date.now;
    this.createId = dependencies.createId ?? (() => crypto.randomUUID());
    this.heartbeatLeadMs = boundedDuration(
      options.heartbeatLeadMs ?? HEARTBEAT_LEAD_MS,
      5_000,
      60_000,
    );
    this.setTimeoutFn = dependencies.setTimeout ?? setTimeout;
    this.clearTimeoutFn = dependencies.clearTimeout ?? clearTimeout;
  }

  async connect(input: RacpAdapterConnectInput): Promise<RacpAdapterConnection> {
    if (input.agentName !== this.agentName) {
      throw new TypeError(
        "The hosted RACP connection agent must match the configured identity.",
      );
    }
    await this.closeTransport(false);
    const generation = ++this.generation;
    this.connectInput = input;
    try {
      throwIfAborted(input.signal);
      await this.mcp.connect?.(input.signal);
      if (!this.isCurrent(generation, input.signal)) throw abortedError();
      const response = await this.mcp.call<Record<string, unknown>>(
        "rnby_racp_register_agent",
        {
          name: this.agentName,
          machine: this.machine,
          capabilities: this.capabilities,
        },
        { signal: input.signal },
      );
      if (!this.isCurrent(generation, input.signal)) throw abortedError();
      this.issue = parseTransportIssue(
        response,
        this.agentName,
        this.machine,
        this.tenantSlug,
        this.now(),
      );
      await this.openRealtime(generation, input);
      this.scheduleHeartbeat(generation);
    } catch (error) {
      if (generation === this.generation) await this.closeTransport(false);
      throw error;
    }
    return {
      close: async () => {
        if (generation === this.generation) await this.closeTransport(true);
      },
    };
  }

  async discover(
    input: RacpDiscoverInput,
    signal: AbortSignal,
  ): Promise<readonly RacpAgentDescription[]> {
    if (input.capability) {
      const limit = Math.min(input.limit ?? 20, 50);
      const result = await this.mcp.call<unknown>(
        "rnby_racp_discover_agents",
        {
          capability_tags: [input.capability],
          ...(input.name ? { name: input.name } : {}),
          status: input.status ?? "any",
          limit,
        },
        { signal },
      );
      if (!Array.isArray(result)) throw invalidHostedResponse();
      return result.map((value) =>
        parseDiscoveredAgent(value, input.capability as string),
      );
    }
    const result = await this.mcp.call<Record<string, unknown>>(
      "rnby_racp_query_agents",
      {
        ...(input.name ? { name: input.name } : {}),
        ...(input.status ? { status: input.status } : {}),
        limit: input.limit ?? 50,
      },
      { signal },
    );
    if (!Array.isArray(result.agents)) throw invalidHostedResponse();
    return result.agents.map(parseAgent);
  }

  async routeCapability(
    input: RacpRouteInput,
    signal: AbortSignal,
  ): Promise<RacpAgentDescription> {
    const result = await this.mcp.call<Record<string, unknown>>(
      "rnby_racp_route_agent",
      {
        capability_tags: [input.capability],
        status: input.status ?? "any",
      },
      { signal },
    );
    const selected = parseDiscoveredAgent(result.selectedAgent, input.capability);
    const routingId = boundedText(
      stringField(result, "routingId"),
      "routing id",
      64,
    );
    const trustLevel = stringField(result, "trustLevel");
    const executionAuthority = stringField(result, "executionAuthority");
    const reason = boundedText(stringField(result, "reason"), "route reason", 2_048);
    const availability = jsonRecord(result.availability);
    const matchingSkill = jsonRecord(result.matchingSkill);
    if (
      !/^[0-9a-f]{64}$/.test(routingId) ||
      !["declared", "tenant_approved", "rnby_verified"].includes(trustLevel) ||
      executionAuthority !== "none" ||
      availability.status !== selected.status
    ) {
      throw invalidHostedResponse();
    }
    return {
      ...selected,
      metadata: {
        ...(selected.metadata ?? {}),
        route: {
          routingId,
          matchingSkill,
          trustLevel,
          availability,
          reason,
          executionAuthority,
        },
      },
    };
  }

  async listMessages(
    input: {
      toAgent: string;
      cursor: { createdAt: string; messageId: string } | null;
      limit: number;
    },
    signal: AbortSignal,
  ): Promise<RacpMessagePage> {
    if (input.toAgent !== this.agentName || input.limit < 1 || input.limit > 100) {
      throw new TypeError("The hosted RACP inbox page request is invalid.");
    }
    const result = await this.mcp.call<Record<string, unknown>>(
      "rnby_racp_get_messages",
      {
        to_agent: input.toAgent,
        delivery_status: "queued",
        ...(input.cursor
          ? {
              after_created_at: input.cursor.createdAt,
              after_id: input.cursor.messageId,
            }
          : {}),
        limit: input.limit,
      },
      { signal },
    );
    if (!Array.isArray(result.messages) || typeof result.has_more !== "boolean") {
      throw invalidHostedResponse();
    }
    const messages = result.messages.map(parseStoredMessage);
    let nextCursor = null;
    if (result.has_more) {
      const cursor = asRecord(result.next_cursor);
      const createdAt = stringField(cursor, "after_created_at");
      const messageId = uuidField(cursor, "after_id");
      nextCursor = { createdAt, messageId };
    }
    return { messages, nextCursor };
  }

  /**
   * The hosted service assigns durable `sent_at`; the signed client timestamp
   * is validated for input coherence but is not an authoritative server time.
   */
  async persistMessage(
    input: RacpPersistMessageInput,
    signal: AbortSignal,
  ): Promise<RacpPersistedMessage> {
    this.assertActor(input.fromAgent, "message sender");
    if (Object.keys(input.metadata).length > 0) {
      throw new TypeError(
        "The hosted RACP MCP message contract does not accept message metadata.",
      );
    }
    const decoded = await unpack(input.envelope);
    if (
      decoded.version !== input.protocolVersion ||
      decoded.fromAgent !== input.fromAgent ||
      decoded.toAgent !== input.toAgent ||
      decoded.taskId !== input.taskId ||
      decoded.intentCode !== input.intentCode ||
      !timestampMatches(decoded.sentAtMillis, input.sentAtMillis) ||
      !equalBytes(decoded.payloadHash, input.payloadHash)
    ) {
      throw new TypeError("RACP outbound envelope did not match its durable fields.");
    }
    const result = await this.mcp.call<Record<string, unknown>>(
      "rnby_racp_send_message",
      {
        from_agent: input.fromAgent,
        to_agent: input.toAgent,
        intent: decoded.intent.toLowerCase(),
        payload_base64: bytesToBase64(decoded.payload),
        idempotency_key: input.idempotencyKey,
        ...(input.taskId ? { task_id: input.taskId } : {}),
        ...(input.replyToMessageId
          ? { reply_to_message_id: input.replyToMessageId }
          : {}),
      },
      { signal },
    );
    return parsePersistedMessage(asRecord(result.message));
  }

  markDelivered(messageId: string, signal: AbortSignal): Promise<void> {
    return this.updateDelivery(messageId, "delivered", signal);
  }

  markFailed(messageId: string, signal: AbortSignal): Promise<void> {
    return this.updateDelivery(messageId, "failed", signal);
  }

  acknowledge(messageId: string, signal: AbortSignal): Promise<void> {
    return this.updateDelivery(messageId, "acknowledged", signal);
  }

  async createTask(
    input: RacpTaskCreateAdapterInput,
    signal: AbortSignal,
  ): Promise<RacpTaskRecord> {
    this.assertActor(input.createdByAgent, "task creator");
    const result = await this.mcp.call<Record<string, unknown>>(
      "rnby_racp_create_task",
      {
        task_id: input.id,
        created_by_agent: input.createdByAgent,
        assigned_to_agent: input.assignedToAgent,
        metadata: input.metadata,
      },
      { signal },
    );
    return parseTask(asRecord(result.task));
  }

  async updateTask(
    input: RacpTaskUpdateAdapterInput,
    signal: AbortSignal,
  ): Promise<RacpTaskRecord> {
    this.assertActor(input.actingAgent, "task actor");
    const result = await this.mcp.call<Record<string, unknown>>(
      "rnby_racp_update_task",
      {
        task_id: input.taskId,
        acting_agent: input.actingAgent,
        status: input.status,
        ...(input.artifacts ? { artifacts: input.artifacts } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
      { signal },
    );
    return parseTask(asRecord(result.task));
  }

  private async updateDelivery(
    messageId: string,
    status: "delivered" | "acknowledged" | "failed",
    signal: AbortSignal,
  ): Promise<void> {
    await this.mcp.call(
      "rnby_racp_acknowledge_message",
      {
        to_agent: this.agentName,
        message_id: messageId,
        delivery_status: status,
      },
      { signal },
    );
  }

  private async openRealtime(
    generation: number,
    input: RacpAdapterConnectInput,
  ): Promise<void> {
    const issue = this.requireIssue();
    this.messageReady = false;
    this.presenceReady = false;
    this.connectedNotified = false;
    this.dataClient = this.createSupabaseClient(
      issue.supabaseUrl,
      issue.supabaseAnonKey,
      clientOptions(async () => this.issue?.dataToken ?? null),
    );
    this.realtimeClient = this.createSupabaseClient(
      issue.supabaseUrl,
      issue.supabaseAnonKey,
      clientOptions(async () => this.issue?.realtimeToken ?? null),
    );
    const realtimeClient = this.realtimeClient;
    await realtimeClient.realtime.setAuth();
    if (
      !this.isCurrent(generation, input.signal) ||
      this.realtimeClient !== realtimeClient
    ) throw abortedError();

    const ready = deferred<void>();
    const timeout = this.setTimeoutFn(() => {
      ready.reject(new Error("RACP private Realtime channels timed out."));
    }, JOIN_TIMEOUT_MS);
    const abort = () => ready.reject(new DOMException("Aborted", "AbortError"));
    input.signal.addEventListener("abort", abort, { once: true });
    this.createMessageChannel(generation, input, ready);
    this.createPresenceChannel(generation, input, ready);

    try {
      await ready.promise;
    } finally {
      this.clearTimeoutFn(timeout);
      input.signal.removeEventListener("abort", abort);
    }
  }

  private createMessageChannel(
    generation: number,
    input: RacpAdapterConnectInput,
    ready: Deferred<void> | null,
  ): void {
    const issue = this.requireIssue();
    const client = this.realtimeClient;
    if (!client) throw new Error("RACP Realtime client is not available.");
    const channel = client.channel(buildInboxTopic(issue.tenantId, this.agentName), {
      config: { private: true },
    });
    channel.on("broadcast", { event: "message" }, (event) => {
      void this.handleBroadcast(generation, input, channel, event);
    });
    this.messageChannel = channel;
    channel.subscribe((status, error) => {
      this.handleChannelStatus(
        generation,
        input,
        "message",
        channel,
        status,
        ready,
        error,
      );
    });
  }

  private createPresenceChannel(
    generation: number,
    input: RacpAdapterConnectInput,
    ready: Deferred<void> | null,
  ): void {
    const issue = this.requireIssue();
    const client = this.realtimeClient;
    if (!client) throw new Error("RACP Realtime client is not available.");
    const sessionId = this.createId();
    if (!UUID_PATTERN.test(sessionId)) {
      throw new TypeError("RACP Realtime session id must be a UUID.");
    }
    const channel = client.channel(
      buildPresenceTopic(issue.tenantId, this.agentName),
      {
        config: {
          private: true,
          presence: { key: sessionId, enabled: true },
        },
      },
    );
    this.presenceChannel = channel;
    channel.subscribe((status, error) => {
      this.handleChannelStatus(
        generation,
        input,
        "presence",
        channel,
        status,
        ready,
        error,
        sessionId,
      );
    });
  }

  private handleChannelStatus(
    generation: number,
    input: RacpAdapterConnectInput,
    kind: "message" | "presence",
    channel: RacpRealtimeChannelLike,
    status: RealtimeStatus,
    ready: Deferred<void> | null,
    cause?: Error,
    sessionId?: string,
  ): void {
    if (!this.isCurrentChannel(generation, input.signal, kind, channel)) return;
    if (status === "CLOSED" && this.replacingChannels.has(channel as object)) return;
    if (status === "SUBSCRIBED") {
      if (kind === "message") {
        this.messageReady = true;
        this.maybeReady(input, ready);
      } else if (sessionId) {
        void this.activatePresence(generation, sessionId, channel, input, ready);
      }
      return;
    }
    if (kind === "message") this.messageReady = false;
    else this.presenceReady = false;
    this.reportRealtimeState(input, status, cause);
    if (status === "CLOSED") {
      void this.replaceClosedChannel(generation, input, kind, channel, ready);
    }
  }

  private async replaceClosedChannel(
    generation: number,
    input: RacpAdapterConnectInput,
    kind: "message" | "presence",
    channel: RacpRealtimeChannelLike,
    ready: Deferred<void> | null,
  ): Promise<void> {
    if (this.replacingChannels.has(channel as object)) return;
    this.replacingChannels.add(channel as object);
    try {
      const client = this.realtimeClient;
      if (!client) return;
      await Promise.resolve(client.removeChannel(channel));
      if (!this.isCurrentChannel(generation, input.signal, kind, channel)) return;
      if (kind === "message") {
        this.messageChannel = null;
        this.createMessageChannel(generation, input, ready);
      } else {
        this.presenceChannel = null;
        this.createPresenceChannel(generation, input, ready);
      }
    } catch (cause) {
      if (!this.isCurrent(generation, input.signal)) return;
      input.onStateChange("degraded");
      input.onError(
        new Error("RACP could not recreate a closed private channel.", { cause }),
      );
    } finally {
      this.replacingChannels.delete(channel as object);
    }
  }

  private async handleBroadcast(
    generation: number,
    input: RacpAdapterConnectInput,
    channel: RacpRealtimeChannelLike,
    value: unknown,
  ): Promise<void> {
    if (!this.isCurrentChannel(generation, input.signal, "message", channel)) return;
    if (!isBinaryMessageBroadcast(value)) {
      input.onError(new Error("RACP received an invalid private binary wake."));
      return;
    }
    const decoded = await tryUnpack(value.payload);
    if (!this.isCurrentChannel(generation, input.signal, "message", channel)) return;
    if (!decoded.ok || decoded.envelope.toAgent !== this.agentName) {
      input.onError(new Error("RACP received an invalid private binary wake."));
      return;
    }
    try {
      await input.onWake();
    } catch (cause) {
      input.onError(new Error("RACP durable inbox wake handling failed.", { cause }));
    }
  }

  private async activatePresence(
    generation: number,
    sessionId: string,
    channel: RacpRealtimeChannelLike,
    input: RacpAdapterConnectInput,
    ready: Deferred<void> | null,
  ): Promise<void> {
    if (this.activatingPresenceChannels.has(channel as object)) return;
    this.activatingPresenceChannels.add(channel as object);
    try {
      const dataClient = this.dataClient;
      if (!dataClient) throw new Error("RACP Data client was unavailable.");
      const tracked = await channel.track({
        agent_name: this.agentName,
        session_id: sessionId,
        protocol_version: 1,
        online_at: new Date(this.now()).toISOString(),
      });
      if (tracked !== "ok") throw new Error("RACP Presence track failed.");
      if (!this.isCurrentChannel(generation, input.signal, "presence", channel)) return;
      await this.setPresenceWithClient(dataClient, true);
      if (!this.isCurrentChannel(generation, input.signal, "presence", channel)) return;
      this.presenceReady = true;
      this.maybeReady(input, ready);
    } catch (error) {
      if (!this.isCurrentChannel(generation, input.signal, "presence", channel)) return;
      input.onStateChange("degraded");
      input.onError(new Error("RACP private Presence could not be established."));
      ready?.reject(error);
    } finally {
      this.activatingPresenceChannels.delete(channel as object);
    }
  }

  private maybeReady(
    input: RacpAdapterConnectInput,
    ready: Deferred<void> | null,
  ): void {
    if (!this.messageReady || !this.presenceReady) return;
    input.onStateChange("connected");
    if (this.connectedNotified) {
      void Promise.resolve(input.onWake()).catch((error) => input.onError(error));
    }
    this.connectedNotified = true;
    ready?.resolve(undefined);
  }

  private reportRealtimeState(
    input: RacpAdapterConnectInput,
    status: RealtimeStatus,
    cause?: Error,
  ): void {
    if (status === "TIMED_OUT" || status === "CHANNEL_ERROR" || status === "CLOSED") {
      input.onStateChange("degraded");
      input.onError(
        new Error(
          status === "CLOSED"
            ? "RACP private Realtime channel closed."
            : "RACP private Realtime channel is temporarily unavailable.",
          cause ? { cause } : undefined,
        ),
      );
    }
  }

  private scheduleHeartbeat(generation: number): void {
    this.clearHeartbeat();
    const issue = this.requireIssue();
    const delay = Math.max(
      1_000,
      issue.expiresAt - this.now() - this.heartbeatLeadMs,
    );
    this.heartbeatTimer = this.setTimeoutFn(() => {
      this.heartbeatTimer = null;
      void this.heartbeat(generation);
    }, delay);
  }

  private async heartbeat(generation: number): Promise<void> {
    const input = this.connectInput;
    if (!input || !this.isCurrent(generation, input.signal)) return;
    try {
      let response: Record<string, unknown>;
      try {
        response = await this.mcp.call(
          "rnby_racp_heartbeat_agent",
          { name: this.agentName },
          { signal: input.signal },
        );
      } catch (error) {
        if (!isLeaseExpired(error)) throw error;
        if (!this.isCurrent(generation, input.signal)) return;
        response = await this.mcp.call(
          "rnby_racp_register_agent",
          {
            name: this.agentName,
            machine: this.machine,
            capabilities: this.capabilities,
          },
          { signal: input.signal },
        );
      }
      if (!this.isCurrent(generation, input.signal)) return;
      const next = parseTransportIssue(
        response,
        this.agentName,
        this.machine,
        this.tenantSlug,
        this.now(),
      );
      const previous = this.requireIssue();
      if (
        next.tenantId !== previous.tenantId ||
        next.supabaseUrl !== previous.supabaseUrl ||
        next.supabaseAnonKey !== previous.supabaseAnonKey
      ) {
        throw new Error("RACP transport configuration changed during renewal.");
      }
      const realtimeClient = this.realtimeClient;
      const dataClient = this.dataClient;
      if (!realtimeClient || !dataClient) return;
      this.issue = next;
      await realtimeClient.realtime.setAuth();
      if (!this.isCurrent(generation, input.signal)) return;
      await this.setPresenceWithClient(dataClient, true);
      if (!this.isCurrent(generation, input.signal)) return;
      input.onStateChange(
        this.messageReady && this.presenceReady ? "connected" : "degraded",
      );
      this.scheduleHeartbeat(generation);
    } catch {
      if (!this.isCurrent(generation, input.signal)) return;
      input.onStateChange("degraded");
      input.onError(new Error("RACP short-lived transport renewal failed."));
      this.heartbeatTimer = this.setTimeoutFn(
        () => void this.heartbeat(generation),
        5_000,
      );
    }
  }

  private async setPresence(online: boolean): Promise<void> {
    const client = this.dataClient;
    if (!client) throw new Error("RACP Data client is not available.");
    await this.setPresenceWithClient(client, online);
  }

  private async setPresenceWithClient(
    client: RacpSupabaseClientLike,
    online: boolean,
  ): Promise<void> {
    const result = await client.rpc("racp_set_agent_presence", {
      p_agent_name: this.agentName,
      p_online: online,
    });
    if (result.error) throw result.error;
  }

  private async closeTransport(closeMcp: boolean): Promise<void> {
    ++this.generation;
    this.clearHeartbeat();
    const realtimeClient = this.realtimeClient;
    const channels = [this.messageChannel, this.presenceChannel].filter(
      (channel): channel is RacpRealtimeChannelLike => channel !== null,
    );
    try {
      await this.presenceChannel?.untrack();
      await this.setPresence(false);
    } catch {
      // The short lease is the final shutdown boundary.
    }
    if (realtimeClient) {
      await Promise.allSettled(
        channels.map((channel) => Promise.resolve(realtimeClient.removeChannel(channel))),
      );
    }
    this.messageChannel = null;
    this.presenceChannel = null;
    this.dataClient = null;
    this.realtimeClient = null;
    this.issue = null;
    this.connectInput = null;
    this.messageReady = false;
    this.presenceReady = false;
    this.connectedNotified = false;
    if (closeMcp) await this.mcp.close?.();
  }

  private clearHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    this.clearTimeoutFn(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private requireIssue(): TransportIssue {
    if (!this.issue) throw new Error("RACP transport is not registered.");
    return this.issue;
  }

  private assertActor(value: string, label: string): void {
    if (value !== this.agentName) {
      throw new TypeError(`The hosted RACP ${label} must match the configured identity.`);
    }
  }

  private isCurrent(generation: number, signal: AbortSignal): boolean {
    return generation === this.generation && !signal.aborted;
  }

  private isCurrentChannel(
    generation: number,
    signal: AbortSignal,
    kind: "message" | "presence",
    channel: RacpRealtimeChannelLike,
  ): boolean {
    return this.isCurrent(generation, signal) &&
      (kind === "message"
        ? this.messageChannel === channel
        : this.presenceChannel === channel);
  }
}

function defaultSupabaseClientFactory(
  url: string,
  anonKey: string,
  options: Parameters<RacpSupabaseClientFactory>[2],
): RacpSupabaseClientLike {
  return createClient(url, anonKey, options) as unknown as RacpSupabaseClientLike;
}

function clientOptions(accessToken: () => Promise<string | null>) {
  return {
    accessToken,
    auth: {
      autoRefreshToken: false as const,
      detectSessionInUrl: false as const,
      persistSession: false as const,
    },
  };
}

function parseTransportIssue(
  value: unknown,
  expectedAgentName: string,
  expectedMachine: string,
  expectedTenantSlug: string,
  now: number,
): TransportIssue {
  const response = asRecord(value);
  const agent = parseRegisteredAgent(response.agent);
  if (
    agent.name !== expectedAgentName ||
    agent.machine !== expectedMachine ||
    agent.owned_by_caller !== true
  ) {
    throw invalidHostedResponse();
  }
  const dataCredential = parseCredential(response.credential);
  const realtimeCredential = parseCredential(response.realtime_credential);
  const transport = asRecord(response.transport_config);
  const dataToken = dataCredential.accessToken;
  const realtimeToken = realtimeCredential.accessToken;
  const dataExpiry = dataCredential.expiresAt;
  const realtimeExpiry = realtimeCredential.expiresAt;
  const tenantId = uuidField(transport, "tenant_id");
  const tenantSlug = boundedSlug(stringField(transport, "tenant_slug"));
  const supabaseUrl = safeHttpsUrl(stringField(transport, "supabase_url"));
  const supabaseAnonKey = secretField(transport, "supabase_anon_key");
  const expiresAt = Math.min(dataExpiry, realtimeExpiry);
  if (
    dataToken === realtimeToken ||
    dataCredential.jti === realtimeCredential.jti ||
    tenantSlug !== expectedTenantSlug ||
    supabaseAnonKey.length > 4_096 ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now + 1_000
  ) {
    throw invalidHostedResponse();
  }
  return {
    dataToken,
    realtimeToken,
    expiresAt,
    tenantId,
    tenantSlug,
    supabaseUrl,
    supabaseAnonKey,
  };
}

function parseCredential(value: unknown): {
  accessToken: string;
  jti: string;
  expiresAt: number;
} {
  const row = asRecord(value);
  const accessToken = secretField(row, "access_token");
  const issuedAt = Date.parse(stringField(row, "issued_at"));
  const expiresAt = Date.parse(stringField(row, "expires_at"));
  const jti = uuidField(row, "jti");
  if (
    !COMPACT_JWT_PATTERN.test(accessToken) ||
    row.token_type !== "Bearer" ||
    row.expires_in !== 90 ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt - issuedAt !== CREDENTIAL_TTL_MS
  ) {
    throw invalidHostedResponse();
  }
  return { accessToken, jti, expiresAt };
}

function parseRegisteredAgent(value: unknown): Record<string, unknown> & {
  name: string;
  machine: string;
  owned_by_caller: boolean;
} {
  const row = asRecord(value);
  uuidField(row, "id");
  const name = agentField(row, "name");
  const machine = boundedText(stringField(row, "machine"), "machine", 255);
  const status = row.status;
  jsonRecord(row.capabilities);
  if (
    (status !== "online" && status !== "offline") ||
    typeof row.owned_by_caller !== "boolean" ||
    !optionalTimestamp(row.last_seen) ||
    !optionalTimestamp(row.presence_expires_at)
  ) {
    throw invalidHostedResponse();
  }
  return { ...row, name, machine, owned_by_caller: row.owned_by_caller };
}

function parseAgent(value: unknown): RacpAgentDescription {
  const row = asRecord(value);
  const status = row.status;
  if (status !== "online" && status !== "offline") throw invalidHostedResponse();
  const capabilities = jsonRecord(row.capabilities);
  return {
    name: agentField(row, "name"),
    status,
    capabilities,
    ...(typeof row.machine === "string" ? { machine: row.machine } : {}),
  };
}

function parseDiscoveredAgent(
  value: unknown,
  matchedCapability: string,
): RacpAgentDescription {
  const row = asRecord(value);
  const name = agentField(row, "agentName");
  const availability = asRecord(row.availability);
  const status = availability.status;
  if (status !== "online" && status !== "offline") throw invalidHostedResponse();
  if (!Array.isArray(row.capabilityTags) || !Array.isArray(row.matchingSkills)) {
    throw invalidHostedResponse();
  }
  const tags = row.capabilityTags.map((entry) =>
    boundedText(stringValue(entry), "capability tag", 127),
  );
  const skillIds = row.matchingSkills.map((entry) => {
    const skill = asRecord(entry);
    return boundedText(stringField(skill, "id"), "skill id", 128);
  });
  const functions = [...new Set([matchedCapability, ...tags, ...skillIds])];
  return {
    name,
    status,
    capabilities: { functions },
    metadata: jsonRecord(row),
  };
}

function parseTask(row: Record<string, unknown>): RacpTaskRecord {
  const status = row.status;
  if (!isTaskStatus(status) || !Array.isArray(row.artifacts)) {
    throw invalidHostedResponse();
  }
  return {
    id: uuidField(row, "id"),
    createdByAgent: agentField(row, "created_by_agent"),
    assignedToAgent: agentField(row, "assigned_to_agent"),
    status,
    artifacts: jsonArray(row.artifacts),
    metadata: jsonRecord(row.metadata),
    createdAt: timestampField(row, "created_at"),
    updatedAt: timestampField(row, "updated_at"),
  };
}

function parseStoredMessage(value: unknown): RacpStoredMessage {
  const row = asRecord(value);
  return {
    id: uuidField(row, "id"),
    envelope: base64ToBytes(stringField(row, "envelope_base64")),
    createdAt: timestampField(row, "created_at"),
    idempotencyKey: boundedText(
      stringField(row, "idempotency_key"),
      "idempotency_key",
      128,
    ),
    replyToMessageId:
      row.reply_to_message_id === null
        ? null
        : uuidField(row, "reply_to_message_id"),
    deliveryStatus: deliveryStatus(row.delivery_status),
    metadata: jsonRecord(row.metadata),
  };
}

function parsePersistedMessage(row: Record<string, unknown>): RacpPersistedMessage {
  return {
    id: uuidField(row, "id"),
    createdAt: timestampField(row, "created_at"),
    deliveryStatus: deliveryStatus(row.delivery_status),
  };
}

function buildInboxTopic(tenantId: string, agentName: string): string {
  return `racp:agent:${tenantId}:${agentName}`;
}

function buildPresenceTopic(tenantId: string, agentName: string): string {
  return `racp:presence:${tenantId}:${agentName}`;
}

function deliveryStatus(value: unknown): RacpStoredMessage["deliveryStatus"] {
  if (
    value === "queued" ||
    value === "delivered" ||
    value === "acknowledged" ||
    value === "failed"
  ) {
    return value;
  }
  throw invalidHostedResponse();
}

function isTaskStatus(value: unknown): value is RacpTaskRecord["status"] {
  return (
    value === "created" ||
    value === "working" ||
    value === "completed" ||
    value === "failed" ||
    value === "aborted"
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidHostedResponse();
  }
  return value as Record<string, unknown>;
}

function jsonRecord(value: unknown): Readonly<Record<string, RacpJsonValue>> {
  const record = asRecord(value);
  if (!Object.values(record).every(isJsonValue)) throw invalidHostedResponse();
  return record as Readonly<Record<string, RacpJsonValue>>;
}

function jsonArray(value: readonly unknown[]): readonly RacpJsonValue[] {
  if (!value.every(isJsonValue)) throw invalidHostedResponse();
  return value as readonly RacpJsonValue[];
}

function isJsonValue(value: unknown): value is RacpJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return Boolean(value) && typeof value === "object" &&
    Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function timestampMatches(actual: bigint, expected: number | bigint): boolean {
  if (typeof expected === "bigint") return actual === expected;
  return Number.isSafeInteger(expected) && actual === BigInt(expected);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (!(right instanceof Uint8Array) || left.byteLength !== right.byteLength) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    mismatch |= left[index]! ^ right[index]!;
  }
  return mismatch === 0;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) throw invalidHostedResponse();
  return value;
}

function uuidField(record: Record<string, unknown>, key: string): string {
  const value = stringField(record, key);
  if (!UUID_PATTERN.test(value)) throw invalidHostedResponse();
  return value;
}

function agentField(record: Record<string, unknown>, key: string): string {
  const value = stringField(record, key);
  assertAgentName(value);
  return value;
}

function timestampField(record: Record<string, unknown>, key: string): string {
  const value = stringField(record, key);
  if (!Number.isFinite(Date.parse(value))) throw invalidHostedResponse();
  return value;
}

function secretField(record: Record<string, unknown>, key: string): string {
  const value = stringField(record, key);
  if (value.length > 16_384) throw invalidHostedResponse();
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || !value) throw invalidHostedResponse();
  return value;
}

function optionalTimestamp(value: unknown): boolean {
  return value === null ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function boundedSlug(value: string): string {
  if (!TENANT_SLUG_PATTERN.test(value)) {
    throw new TypeError("RACP hosted adapter requires a canonical tenant slug.");
  }
  return value;
}

function safeHttpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw invalidHostedResponse();
  }
  return url.toString();
}

function assertAgentName(value: string): void {
  if (!AGENT_NAME_PATTERN.test(value)) {
    throw new TypeError("RACP hosted adapter requires a canonical agent name.");
  }
}

function boundedText(value: string, label: string, maximum: number): string {
  const text = value.trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new TypeError(`${label} must contain 1..${maximum} safe characters.`);
  }
  return text;
}

function boundedDuration(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`RACP duration must be between ${minimum} and ${maximum}ms.`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortedError();
}

function abortedError(): DOMException {
  return new DOMException("RACP operation was aborted.", "AbortError");
}

function isLeaseExpired(error: unknown): boolean {
  return error instanceof RacpMcpToolError &&
    error.code?.toUpperCase() === "RACP_LEASE_EXPIRED";
}

function isBinaryMessageBroadcast(value: unknown): value is {
  type: "broadcast";
  event: "message";
  payload: ArrayBuffer;
  meta?: Record<string, unknown>;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === "broadcast" &&
    candidate.event === "message" &&
    candidate.payload instanceof ArrayBuffer &&
    (candidate.meta === undefined ||
      (candidate.meta !== null && typeof candidate.meta === "object"));
}

function invalidHostedResponse(): TypeError {
  return new TypeError("RnBy hosted RACP service returned an invalid response.");
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
