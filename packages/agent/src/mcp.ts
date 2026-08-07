import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  auth,
  extractWWWAuthenticateParams,
  type AuthProvider,
  type OAuthClientProvider,
} from "@modelcontextprotocol/client";

const RACP_REQUIRED_SCOPE = "mcp:read mcp:racp";

const TOOL_ALIASES = {
  query_agents: "rnby_racp_query_agents",
  discover_agents: "rnby_racp_discover_agents",
  route_agent: "rnby_racp_route_agent",
  register_agent: "rnby_racp_register_agent",
  heartbeat_agent: "rnby_racp_heartbeat_agent",
  create_task: "rnby_racp_create_task",
  prepare_artifact_upload: "rnby_racp_prepare_artifact_upload",
  cancel_artifact_upload: "rnby_racp_cancel_artifact_upload",
  send_message: "rnby_racp_send_message",
  get_messages: "rnby_racp_get_messages",
  get_task_events: "rnby_racp_get_task_events",
  resolve_artifact: "rnby_racp_resolve_artifact",
  acknowledge_message: "rnby_racp_acknowledge_message",
  update_task: "rnby_racp_update_task",
} as const;

export type RacpMcpToolName =
  | keyof typeof TOOL_ALIASES
  | (typeof TOOL_ALIASES)[keyof typeof TOOL_ALIASES];

export interface RacpMcpOAuthClientProvider extends OAuthClientProvider {
  runAuthorizationExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export type RacpMcpAuthentication =
  | {
      kind: "oauth";
      provider: RacpMcpOAuthClientProvider;
      validateAuthorizationCallback: (
        params: URLSearchParams,
      ) => void | Promise<void>;
    }
  | { kind: "provider"; provider: AuthProvider };

export interface RacpMcpClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: "auto" | "2026-07-28";
  cachePartition?: string;
}

export interface RacpMcpCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class RacpMcpToolError extends Error {
  readonly code: string | null;
  declare readonly cause?: unknown;

  constructor(message: string, code: string | null = null, cause?: unknown) {
    super(message);
    this.name = "RacpMcpToolError";
    this.code = code;
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: cause,
      });
    }
  }
}

/** Official MCP 2026 Streamable HTTP client for the RACP tool surface. */
export class RacpMcpClient {
  readonly url: string;
  private readonly parsedUrl: URL;
  private readonly authentication: RacpMcpAuthentication;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly protocolVersion: "auto" | "2026-07-28";
  private readonly cachePartition: string | undefined;
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private connectPromise: Promise<void> | null = null;
  private authorizationPromise: Promise<void> | null = null;

  constructor(
    url: string,
    authentication: RacpMcpAuthentication,
    options: RacpMcpClientOptions = {},
  ) {
    this.parsedUrl = normalizeMcpUrl(url);
    this.url = this.parsedUrl.toString();
    this.authentication = normalizeAuthentication(authentication);
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = boundedTimeout(options.timeoutMs);
    this.clientName = normalizeClientLabel(options.clientName, "rnby-racp-client");
    this.clientVersion = normalizeClientLabel(options.clientVersion, "0.1.0");
    this.protocolVersion = options.protocolVersion ?? "auto";
    this.cachePartition = normalizeCachePartition(options.cachePartition);
  }

  async connect(signal?: AbortSignal): Promise<void> {
    await this.ensureConnected(signal);
  }

  async call<T = Record<string, unknown>>(
    name: RacpMcpToolName | string,
    args: Record<string, unknown>,
    options: RacpMcpCallOptions = {},
  ): Promise<T> {
    const toolName = name in TOOL_ALIASES
      ? TOOL_ALIASES[name as keyof typeof TOOL_ALIASES]
      : name;
    const timeout = boundedTimeout(options.timeoutMs ?? this.timeoutMs);
    try {
      const client = await this.ensureConnected(options.signal);
      const result = await client.callTool(
        { name: toolName, arguments: args },
        {
          ...(options.signal ? { signal: options.signal } : {}),
          timeout,
          maxTotalTimeout: timeout,
        },
      );
      const structured = isRecord(result.structuredContent) ||
          Array.isArray(result.structuredContent)
        ? result.structuredContent
        : null;
      if (!structured) {
        throw new RacpMcpToolError(
          "RACP MCP response did not include structured tool output.",
        );
      }
      if (
        result.isError === true ||
        (isRecord(structured) && typeof structured.error === "string")
      ) {
        const details = isRecord(structured) && isRecord(structured.details)
          ? structured.details
          : null;
        throw new RacpMcpToolError(
          (isRecord(structured) ? safeToolMessage(structured.error) : null) ??
            "RACP MCP tool call failed.",
          details ? safeToolCode(details.code) : null,
        );
      }
      return structured as T;
    } catch (cause) {
      if (cause instanceof RacpMcpToolError) throw cause;
      throw translateSdkError(cause);
    }
  }

  /**
   * Complete the browser callback. State is checked before the SDK validates
   * RFC 9207 `iss` and redeems the authorization code.
   */
  async finishOAuthAuthorization(
    callback: string | URL | URLSearchParams,
  ): Promise<void> {
    if (this.authentication.kind !== "oauth") {
      throw new RacpMcpToolError(
        "RACP MCP OAuth is not configured for this client.",
        "RACP_OAUTH_NOT_CONFIGURED",
      );
    }
    const oauthProvider = this.authentication.provider;
    const validateAuthorizationCallback =
      this.authentication.validateAuthorizationCallback;
    const params = callbackParameters(callback);
    try {
      await oauthProvider.runAuthorizationExclusive(async () => {
        await validateAuthorizationCallback(params);
        const callbackError = singleCallbackValue(params, "error", false);
        if (callbackError) {
          throw new RacpMcpToolError(
            "RACP MCP authorization was denied or did not complete.",
            "RACP_OAUTH_AUTHORIZATION_DENIED",
          );
        }
        const authorizationCode = singleCallbackValue(params, "code", true);
        if (!authorizationCode) {
          throw new TypeError("The OAuth callback code parameter is invalid.");
        }
        const iss = singleCallbackValue(params, "iss", false);
        const result = await auth(oauthProvider, {
          serverUrl: this.parsedUrl,
          authorizationCode,
          ...(iss ? { iss } : {}),
          scope: RACP_REQUIRED_SCOPE,
          fetchFn: this.fetchFn,
        });
        if (result !== "AUTHORIZED") throw authorizationRequired();
        await this.assertRequiredOAuthScopes();
      });
    } catch (cause) {
      if (cause instanceof RacpMcpToolError) throw cause;
      throw translateSdkError(cause);
    } finally {
      await this.resetConnection();
    }
  }

  async close(): Promise<void> {
    await this.resetConnection();
  }

  private async ensureConnected(signal?: AbortSignal): Promise<Client> {
    await this.ensureOAuthAuthorized(signal);
    if (this.client && !this.connectPromise) return this.client;
    if (!this.client) this.createConnection();
    if (!this.connectPromise) {
      const client = this.client as Client;
      const transport = this.transport as StreamableHTTPClientTransport;
      let operation: Promise<void>;
      operation = client
        .connect(transport, {
          ...(signal ? { signal } : {}),
          timeout: this.timeoutMs,
          maxTotalTimeout: this.timeoutMs,
        })
        .catch(async (cause) => {
          await this.resetConnection(client, transport);
          throw cause;
        })
        .finally(() => {
          if (this.connectPromise === operation) this.connectPromise = null;
        });
      this.connectPromise = operation;
    }
    const expectedClient = this.client as Client;
    await this.connectPromise;
    if (this.client !== expectedClient) {
      throw new RacpMcpToolError(
        "RACP MCP connection was closed while it was starting.",
        "RACP_MCP_CONNECTION_CLOSED",
      );
    }
    return expectedClient;
  }

  private async ensureOAuthAuthorized(signal?: AbortSignal): Promise<void> {
    if (this.authentication.kind !== "oauth") return;
    const oauthProvider = this.authentication.provider;
    throwIfAborted(signal);
    const existing = await oauthProvider.tokens();
    throwIfAborted(signal);
    if (hasRequiredScopes(existing?.scope)) return;
    if (!this.authorizationPromise) {
      this.authorizationPromise = oauthProvider.runAuthorizationExclusive(
        async () => {
          const current = await oauthProvider.tokens();
          if (hasRequiredScopes(current?.scope)) return;
          const result = await auth(oauthProvider, {
            serverUrl: this.parsedUrl,
            scope: RACP_REQUIRED_SCOPE,
            fetchFn: this.fetchFn,
            ...(current ? { forceReauthorization: true } : {}),
          });
          if (result !== "AUTHORIZED") throw authorizationRequired();
          await this.assertRequiredOAuthScopes();
        });
      this.authorizationPromise = this.authorizationPromise.finally(() => {
        this.authorizationPromise = null;
      });
    }
    await this.authorizationPromise;
    throwIfAborted(signal);
  }

  private async assertRequiredOAuthScopes(): Promise<void> {
    if (this.authentication.kind !== "oauth") return;
    const tokens = await this.authentication.provider.tokens();
    if (!hasRequiredScopes(tokens?.scope)) {
      throw new RacpMcpToolError(
        "RACP MCP authorization did not grant agent communication access.",
        "RACP_OAUTH_INSUFFICIENT_SCOPE",
      );
    }
  }

  private createConnection(): void {
    this.client = new Client(
      { name: this.clientName, version: this.clientVersion },
      {
        capabilities: {},
        versionNegotiation: {
          mode:
            this.protocolVersion === "auto"
              ? "auto"
              : { pin: this.protocolVersion },
          probe: { timeoutMs: this.timeoutMs, maxRetries: 0 },
        },
        ...(this.cachePartition ? { cachePartition: this.cachePartition } : {}),
      },
    );
    this.transport = this.createTransport();
  }

  private createTransport(): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(this.parsedUrl, {
      authProvider:
        this.authentication.kind === "oauth"
          ? this.createOAuthTransportProvider(this.authentication.provider)
          : this.authentication.provider,
      fetch: this.fetchFn,
      requestInit: { redirect: "error" },
      onInsufficientScope: "throw",
    });
  }

  private createOAuthTransportProvider(
    provider: RacpMcpOAuthClientProvider,
  ): AuthProvider {
    return {
      token: async () => (await provider.tokens())?.access_token,
      onUnauthorized: async (context) => {
        await provider.runAuthorizationExclusive(async () => {
          const { resourceMetadataUrl } = extractWWWAuthenticateParams(
            context.response,
          );
          const result = await auth(provider, {
            serverUrl: context.serverUrl,
            ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
            scope: RACP_REQUIRED_SCOPE,
            fetchFn: context.fetchFn,
          });
          if (result !== "AUTHORIZED") throw authorizationRequired();
          await this.assertRequiredOAuthScopes();
        });
      },
    };
  }

  private async resetConnection(
    expectedClient?: Client,
    expectedTransport?: StreamableHTTPClientTransport,
  ): Promise<void> {
    const client = expectedClient ?? this.client;
    const transport = expectedTransport ?? this.transport;
    const ownsCurrent =
      (!expectedClient || this.client === expectedClient) &&
      (!expectedTransport || this.transport === expectedTransport);
    if (ownsCurrent) {
      this.client = null;
      this.transport = null;
      this.connectPromise = null;
    }
    try {
      if (client) await client.close();
      else if (transport) await transport.close();
    } catch {
      // A failed or already-closed HTTP transport has no further state to use.
    }
  }
}

function normalizeAuthentication(
  value: RacpMcpAuthentication,
): RacpMcpAuthentication {
  if (!value || typeof value !== "object") {
    throw new TypeError("RACP MCP authentication is required.");
  }
  if (value.kind === "provider" && value.provider) return value;
  if (
    value.kind === "oauth" &&
    value.provider &&
    typeof value.provider.runAuthorizationExclusive === "function" &&
    typeof value.validateAuthorizationCallback === "function"
  ) {
    return value;
  }
  throw new TypeError("RACP MCP authentication mode is invalid.");
}

function callbackParameters(value: string | URL | URLSearchParams): URLSearchParams {
  if (value instanceof URLSearchParams) return new URLSearchParams(value);
  try {
    const url = value instanceof URL ? value : new URL(value);
    return new URLSearchParams(url.searchParams);
  } catch {
    throw new TypeError("The OAuth callback must be an absolute URL.");
  }
}

function singleCallbackValue(
  params: URLSearchParams,
  name: string,
  required: boolean,
): string | undefined {
  const values = params.getAll(name);
  if (
    values.length > 1 ||
    (required && values.length !== 1) ||
    (values[0] !== undefined && (!values[0] || values[0].length > 4_096))
  ) {
    throw new TypeError(`The OAuth callback ${name} parameter is invalid.`);
  }
  return values[0];
}

function hasRequiredScopes(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const granted = new Set(value.split(/\s+/).filter(Boolean));
  return RACP_REQUIRED_SCOPE.split(" ").every((scope) => granted.has(scope));
}

function authorizationRequired(): RacpMcpToolError {
  return new RacpMcpToolError(
    "RACP MCP browser authorization is required.",
    "RACP_OAUTH_AUTHORIZATION_REQUIRED",
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("RACP MCP request was aborted.", "AbortError");
}

function translateSdkError(cause: unknown): RacpMcpToolError {
  if (UnauthorizedError.isInstance(cause)) {
    return new RacpMcpToolError(
      "RACP MCP authorization is required or expired.",
      "RACP_OAUTH_AUTHORIZATION_REQUIRED",
      cause,
    );
  }
  if (ProtocolError.isInstance(cause)) {
    return new RacpMcpToolError(
      cause.message || "RACP MCP protocol call failed.",
      extractRacpCode(cause.data),
      cause,
    );
  }
  if (SdkHttpError.isInstance(cause)) {
    return new RacpMcpToolError(
      `RACP MCP request failed with HTTP ${cause.status}.`,
      null,
      cause,
    );
  }
  if (SdkError.isInstance(cause) && cause.code === SdkErrorCode.RequestTimeout) {
    return new RacpMcpToolError("RACP MCP request timed out.", null, cause);
  }
  return new RacpMcpToolError(
    "RACP MCP request failed before a valid response was received.",
    null,
    cause,
  );
}

function extractRacpCode(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = safeToolCode(value.code);
  if (direct) return direct;
  return isRecord(value.details) ? safeToolCode(value.details.code) : null;
}

function safeToolMessage(value: unknown): string | null {
  return typeof value === "string" && value.length <= 512 ? value : null;
}

function safeToolCode(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
    ? value
    : null;
}

function normalizeMcpUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("RACP MCP URL must be an absolute HTTP(S) URL.");
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))
  ) {
    throw new TypeError(
      "RACP MCP URL must use HTTPS (HTTP is allowed only on loopback).",
    );
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("RACP MCP URL cannot contain URL credentials.");
  }
  parsed.hash = "";
  return parsed;
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return 30_000;
  if (!Number.isInteger(value) || value < 1_000 || value > 120_000) {
    throw new TypeError("RACP MCP timeout must be between 1 and 120 seconds.");
  }
  return value;
}

function normalizeClientLabel(value: string | undefined, fallback: string): string {
  const label = (value ?? fallback).trim();
  if (!label || label.length > 128) {
    throw new TypeError("RACP MCP client identity is invalid.");
  }
  return label;
}

function normalizeCachePartition(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > 256) {
    throw new TypeError("RACP MCP cache partition is invalid.");
  }
  return value;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
