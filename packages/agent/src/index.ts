import {
  RacpClient,
  RacpMcpTaskEventSource,
  type RacpClientOptions,
  type RacpJsonValue,
} from "@rnby/racp-client";
import {
  RacpHostedAdapter,
  type RacpHostedAdapterDependencies,
} from "./hosted-adapter.js";
import {
  RacpMcpClient,
  type RacpMcpClientOptions,
} from "./mcp.js";
import { RacpMcpOAuthProvider } from "./oauth.js";

export {
  RacpClient,
  RacpClientError,
  RacpMcpTaskEventSource,
  racp_discover,
  racp_query,
  racp_send,
  racp_task_create,
  supportsCapability,
} from "@rnby/racp-client";
export type {
  RacpAdapter,
  RacpAdapterConnectInput,
  RacpAdapterConnection,
  RacpAgentDescription,
  RacpClientOptions,
  RacpDiscoverInput,
  RacpIncomingMessage,
  RacpMessageDisposition,
  RacpMessageHandler,
  RacpQueryInput,
  RacpSendInput,
  RacpTaskCreateInput,
  RacpTaskRecord,
  RacpTaskEvent,
  RacpTaskEventCursor,
  RacpTaskEventSource,
  RacpTaskUpdateHandler,
} from "@rnby/racp-client";
export {
  RACP_INTENT_CODES,
  RACP_PROTOCOL_VERSION,
  RacpCodecError,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  hashPayload,
  hexToBytes,
  intentCodeForName,
  pack,
  tryUnpack,
  unpack,
} from "@rnby/racp-codec";
export type {
  RacpByteSource,
  RacpIntentCode,
  RacpIntentName,
  RacpV1Envelope,
  RacpV1PackInput,
} from "@rnby/racp-codec";

/** Primary programmatic entry point. The CLI is only an offline test harness. */
export function createRacpAgent(options: RacpClientOptions): RacpClient {
  return new RacpClient(options);
}

export {
  RacpHostedAdapter,
} from "./hosted-adapter.js";
export {
  RacpMcpClient,
  RacpMcpToolError,
} from "./mcp.js";
export {
  RacpMcpOAuthProvider,
} from "./oauth.js";
export type {
  RacpHostedAdapterDependencies,
  RacpHostedAdapterOptions,
  RacpHostedMcpCaller,
  RacpSupabaseClientFactory,
} from "./hosted-adapter.js";
export type {
  RacpMcpAuthentication,
  RacpMcpCallOptions,
  RacpMcpClientOptions,
  RacpMcpOAuthClientProvider,
  RacpMcpToolName,
} from "./mcp.js";
export type {
  RacpMcpOAuthProviderOptions,
  RacpMcpOAuthStorage,
} from "./oauth.js";

export interface RacpHostedAgentOptions
  extends Omit<RacpClientOptions, "adapter" | "taskEventSource"> {
  mcpUrl: string;
  tenantSlug: string;
  machine: string;
  oauth: RacpMcpOAuthProvider;
  capabilities?: Readonly<Record<string, RacpJsonValue>>;
  mcpOptions?: RacpMcpClientOptions;
  adapterDependencies?: RacpHostedAdapterDependencies;
}

/** Directly usable hosted agent: OAuth MCP + durable tools + Realtime wakes. */
export class RacpHostedAgent extends RacpClient {
  private readonly hostedMcp: RacpMcpClient;

  constructor(options: RacpHostedAgentOptions) {
    options.oauth.assertResourceUrl(options.mcpUrl);
    if (
      options.drainPageSize !== undefined &&
      (!Number.isInteger(options.drainPageSize) ||
        options.drainPageSize < 1 ||
        options.drainPageSize > 100)
    ) {
      throw new TypeError("Hosted RACP drainPageSize must be between 1 and 100.");
    }
    const mcp = new RacpMcpClient(
      options.mcpUrl,
      {
        kind: "oauth",
        provider: options.oauth,
        validateAuthorizationCallback: (params) =>
          options.oauth.validateAuthorizationCallback(params),
      },
      options.mcpOptions,
    );
    const adapter = new RacpHostedAdapter(
      {
        agentName: options.agentName,
        tenantSlug: options.tenantSlug,
        machine: options.machine,
        ...(options.capabilities ? { capabilities: options.capabilities } : {}),
        mcp,
      },
      options.adapterDependencies,
    );
    super({
      agentName: options.agentName,
      adapter,
      taskEventSource: new RacpMcpTaskEventSource(mcp),
      ...(options.now ? { now: options.now } : {}),
      ...(options.createId ? { createId: options.createId } : {}),
      ...(options.drainPageSize
        ? { drainPageSize: options.drainPageSize }
        : {}),
      ...(options.taskEventPollMs
        ? { taskEventPollMs: options.taskEventPollMs }
        : {}),
      ...(options.taskEventPageSize
        ? { taskEventPageSize: options.taskEventPageSize }
        : {}),
    });
    this.hostedMcp = mcp;
  }

  finishOAuthAuthorization(
    callback: string | URL | URLSearchParams,
  ): Promise<void> {
    return this.hostedMcp.finishOAuthAuthorization(callback);
  }
}

export function createHostedRacpAgent(
  options: RacpHostedAgentOptions,
): RacpHostedAgent {
  return new RacpHostedAgent(options);
}
