import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";

const DEFAULT_SCOPES = ["mcp:read", "mcp:racp"] as const;
const MAX_STORED_SECRET_LENGTH = 16_384;

/** Caller-owned secure persistence, such as an OS keychain or secret vault. */
export interface RacpMcpOAuthStorage {
  get(key: string): unknown | Promise<unknown>;
  set(key: string, value: unknown): void | Promise<void>;
  /** Atomically replace one secret value; required for refresh-token rotation. */
  replace(key: string, value: unknown): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  /**
   * Hold an exclusive, namespace-scoped lock for the complete operation. Hosts
   * that share credentials across processes must make this lock cross-process.
   */
  runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

export interface RacpMcpOAuthProviderOptions {
  /** Exact protected MCP resource this credential partition may authorize. */
  resourceUrl: string | URL;
  redirectUrl: string | URL;
  storage: RacpMcpOAuthStorage;
  redirectToAuthorization: (authorizationUrl: URL) => void | Promise<void>;
  clientName?: string;
  clientVersion?: string;
  scopes?: readonly string[];
  /** Unique to the signed-in principal and local agent identity. */
  storageNamespace: string;
  stateFactory?: () => string | Promise<string>;
}

/**
 * OAuth 2.1 browser-consent provider for the official MCP client.
 *
 * The MCP SDK owns protected-resource discovery, authorization-server
 * discovery, dynamic registration, PKCE S256, code exchange, and rotating
 * refresh tokens. This class owns only host-provided secure persistence,
 * navigation, and state validation.
 */
export class RacpMcpOAuthProvider implements OAuthClientProvider {
  readonly protectedResourceUrl: URL;
  readonly redirectUrl: URL;
  readonly clientMetadata: OAuthClientMetadata;

  private readonly storage: RacpMcpOAuthStorage;
  private readonly namespace: string;
  private readonly onRedirect: (authorizationUrl: URL) => void | Promise<void>;
  private readonly stateFactory: () => string | Promise<string>;
  private readonly requestedScope = DEFAULT_SCOPES.join(" ");
  private tokenWrite: Promise<void> = Promise.resolve();

  constructor(options: RacpMcpOAuthProviderOptions) {
    this.protectedResourceUrl = normalizeResourceUrl(options.resourceUrl);
    this.redirectUrl = normalizeRedirectUrl(options.redirectUrl);
    assertSecureStorage(options.storage);
    this.storage = options.storage;
    this.namespace = `${normalizeNamespace(options.storageNamespace)}:${encodeURIComponent(this.protectedResourceUrl.toString())}`;
    this.onRedirect = options.redirectToAuthorization;
    this.stateFactory = options.stateFactory ?? randomState;
    const scopes = normalizeScopes([...DEFAULT_SCOPES, ...(options.scopes ?? [])]);
    this.clientMetadata = {
      redirect_uris: [this.redirectUrl.toString()],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "native",
      client_name: normalizeLabel(options.clientName, "RnBy RACP agent"),
      software_id: "ai.rnby.racp-client",
      software_version: normalizeLabel(options.clientVersion, "0.1.0"),
      scope: scopes.join(" "),
    };
  }

  async state(): Promise<string> {
    const state = normalizeOpaqueValue(await this.stateFactory(), "OAuth state");
    await this.storage.set(this.key("state"), state);
    return state;
  }

  async clientInformation(
    context?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    const value = await this.storage.get(this.issuerKey("client", context));
    return parseClientInformation(value, context?.issuer);
  }

  async saveClientInformation(
    information: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    const checked = parseClientInformation(information, context?.issuer);
    if (!checked) throw new TypeError("OAuth client information is invalid.");
    const issuer = context?.issuer ?? checked.issuer;
    const stamped = issuer ? { ...checked, issuer } : checked;
    await this.storage.set(
      this.issuerKey("client", issuer ? { issuer } : undefined),
      stamped,
    );
  }

  async tokens(
    context?: OAuthClientInformationContext,
  ): Promise<StoredOAuthTokens | undefined> {
    const value = await this.storage.get(this.key("tokens:active"));
    return parseTokens(value, context?.issuer);
  }

  async saveTokens(
    tokens: StoredOAuthTokens,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    const checked = parseTokens(tokens, context?.issuer);
    if (!checked) throw new TypeError("OAuth token response is invalid.");
    const issuer = context?.issuer ?? checked.issuer;
    const stamped = {
      ...checked,
      ...(checked.scope ? {} : { scope: this.requestedScope }),
      ...(issuer ? { issuer } : {}),
    };
    // Serialize writes in this provider and require one atomic replacement in
    // caller-owned secure storage. A rotated refresh token is never copied
    // through a plaintext fallback or a second crash-prone slot.
    const write = this.tokenWrite.then(() =>
      this.storage.replace(this.key("tokens:active"), stamped),
    );
    this.tokenWrite = write.then(() => undefined, () => undefined);
    await write;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.onRedirect(new URL(authorizationUrl.toString()));
  }

  /** Serialize discovery, refresh, rotation, and token persistence as one unit. */
  runAuthorizationExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.storage.runExclusive(this.key("authorization"), operation);
  }

  resourceUrl(): string {
    return this.protectedResourceUrl.toString();
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.storage.set(
      this.key("pkce-verifier"),
      normalizeOpaqueValue(codeVerifier, "PKCE verifier"),
    );
  }

  async codeVerifier(): Promise<string> {
    const value = await this.storage.get(this.key("pkce-verifier"));
    if (typeof value !== "string" || value.length < 43 || value.length > 128) {
      throw new TypeError("The saved PKCE verifier is missing or invalid.");
    }
    return value;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    if (!isRecord(state) || !isSafeIssuer(state.authorizationServerUrl)) {
      throw new TypeError("OAuth discovery state is invalid.");
    }
    await this.storage.set(this.key("discovery"), cloneJson(state));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const value = await this.storage.get(this.key("discovery"));
    if (!isRecord(value) || !isSafeIssuer(value.authorizationServerUrl)) {
      return undefined;
    }
    return cloneJson(value) as unknown as OAuthDiscoveryState;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all" || scope === "tokens") {
      await this.storage.delete(this.key("tokens:active"));
    }
    if (scope === "all" || scope === "client") {
      const discovery = await this.discoveryState();
      if (discovery?.authorizationServerUrl) {
        await this.storage.delete(
          this.issuerKey("client", {
            issuer: discovery.authorizationServerUrl,
          }),
        );
      }
    }
    if (scope === "all" || scope === "verifier") {
      await this.storage.delete(this.key("pkce-verifier"));
      await this.storage.delete(this.key("state"));
    }
    if (scope === "all" || scope === "discovery") {
      await this.storage.delete(this.key("discovery"));
    }
  }

  /** Validate and consume state before the SDK validates `iss` and redeems. */
  async validateAuthorizationCallback(params: URLSearchParams): Promise<void> {
    const expected = await this.storage.get(this.key("state"));
    await this.storage.delete(this.key("state"));
    const received = params.get("state");
    if (
      typeof expected !== "string" ||
      typeof received !== "string" ||
      received.length > MAX_STORED_SECRET_LENGTH ||
      !constantTimeEqual(expected, received)
    ) {
      throw new TypeError("OAuth authorization state is missing or invalid.");
    }
  }

  /** Fail closed if a host accidentally pairs this provider with another MCP URL. */
  assertResourceUrl(value: string | URL): void {
    const actual = normalizeResourceUrl(value);
    if (actual.toString() !== this.protectedResourceUrl.toString()) {
      throw new TypeError("The OAuth provider is bound to a different MCP resource.");
    }
  }

  private key(suffix: string): string {
    return `${this.namespace}:${suffix}`;
  }

  private issuerKey(
    kind: "client",
    context?: OAuthClientInformationContext,
  ): string {
    return this.key(
      `${kind}:${encodeURIComponent(context?.issuer ?? "unresolved")}`,
    );
  }
}

function normalizeRedirectUrl(value: string | URL): URL {
  const url = value instanceof URL ? new URL(value.toString()) : new URL(value);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isNumericLoopbackHost(url.hostname))
  ) {
    throw new TypeError(
      "The OAuth redirect URL must use HTTPS (HTTP is allowed only on loopback).",
    );
  }
  if (url.username || url.password || url.hash) {
    throw new TypeError(
      "The OAuth redirect URL cannot contain credentials or a fragment.",
    );
  }
  return url;
}

function normalizeResourceUrl(value: string | URL): URL {
  const url = value instanceof URL ? new URL(value.toString()) : new URL(value);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isNumericLoopbackHost(url.hostname))
  ) {
    throw new TypeError(
      "The OAuth resource URL must use HTTPS (HTTP is allowed only on numeric loopback).",
    );
  }
  if (url.username || url.password || url.hash) {
    throw new TypeError("The OAuth resource URL cannot contain credentials or a fragment.");
  }
  url.hash = "";
  return url;
}

function normalizeNamespace(value: string): string {
  const namespace = (value ?? "").trim();
  if (!/^[a-zA-Z0-9._:@-]{1,128}$/.test(namespace)) {
    throw new TypeError("The OAuth storage namespace is invalid.");
  }
  return namespace;
}

function normalizeScopes(values: readonly string[]): string[] {
  const scopes = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (
    scopes.length === 0 ||
    scopes.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(scope))
  ) {
    throw new TypeError("OAuth scopes are invalid.");
  }
  return scopes.sort();
}

function normalizeLabel(value: string | undefined, fallback: string): string {
  const label = (value ?? fallback).trim();
  if (!label || label.length > 128) {
    throw new TypeError("OAuth client metadata contains an invalid label.");
  }
  return label;
}

function normalizeOpaqueValue(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > MAX_STORED_SECRET_LENGTH
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function parseClientInformation(
  value: unknown,
  expectedIssuer?: string,
): StoredOAuthClientInformation | undefined {
  if (!isRecord(value) || !boundedString(value.client_id, 1, 2_048)) {
    return undefined;
  }
  if (
    value.client_secret !== undefined &&
    !boundedString(value.client_secret, 1)
  ) {
    return undefined;
  }
  if (!issuerMatches(value.issuer, expectedIssuer)) return undefined;
  return cloneJson(value) as StoredOAuthClientInformation;
}

function parseTokens(
  value: unknown,
  expectedIssuer?: string,
): StoredOAuthTokens | undefined {
  if (
    !isRecord(value) ||
    !boundedString(value.access_token, 1) ||
    !boundedString(value.token_type, 1, 64) ||
    (value.refresh_token !== undefined && !boundedString(value.refresh_token, 1)) ||
    (value.scope !== undefined && !boundedString(value.scope, 1, 4_096)) ||
    !issuerMatches(value.issuer, expectedIssuer)
  ) {
    return undefined;
  }
  return cloneJson(value) as StoredOAuthTokens;
}

function assertSecureStorage(value: RacpMcpOAuthStorage): void {
  if (
    !value ||
    typeof value.get !== "function" ||
    typeof value.set !== "function" ||
    typeof value.replace !== "function" ||
    typeof value.delete !== "function" ||
    typeof value.runExclusive !== "function"
  ) {
    throw new TypeError(
      "OAuth storage must provide secure get, set, atomic replace, delete, and exclusive-lock operations.",
    );
  }
}

function issuerMatches(value: unknown, expected: string | undefined): boolean {
  if (value !== undefined && !isSafeIssuer(value)) return false;
  return expected === undefined || value === undefined || value === expected;
}

function isSafeIssuer(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && isLoopbackHost(url.hostname)))
    );
  } catch {
    return false;
  }
}

function boundedString(
  value: unknown,
  minimum: number,
  maximum = MAX_STORED_SECRET_LENGTH,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const size = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < size; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function isNumericLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
