import assert from "node:assert/strict";
import test from "node:test";
import { RacpMcpClient } from "@rnby/racp-agent/mcp";
import { RacpMcpOAuthProvider } from "@rnby/racp-agent/oauth";

class MemorySecureStorage {
  values = new Map();
  locks = new Map();
  async get(key) { return structuredClone(this.values.get(key)); }
  async set(key, value) { this.values.set(key, structuredClone(value)); }
  async replace(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { this.values.delete(key); }
  async runExclusive(key, operation) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.locks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}

test("OAuth provider keeps PKCE, state, client, and rotating tokens in caller storage", async () => {
  const storage = new MemorySecureStorage();
  const redirects = [];
  const provider = new RacpMcpOAuthProvider({
    resourceUrl: "https://tenant.example.com/api/mcp",
    redirectUrl: "http://127.0.0.1:49152/callback",
    storage,
    storageNamespace: "tenant-example:@worker",
    redirectToAuthorization: (url) => redirects.push(url.toString()),
    stateFactory: () => "state-value-that-is-long-enough",
  });

  assert.deepEqual(provider.clientMetadata.grant_types, [
    "authorization_code",
    "refresh_token",
  ]);
  assert.equal(provider.clientMetadata.token_endpoint_auth_method, "none");
  assert.equal(provider.clientMetadata.scope, "mcp:racp mcp:read");
  assert.equal(provider.resourceUrl(), "https://tenant.example.com/api/mcp");
  provider.assertResourceUrl("https://tenant.example.com/api/mcp");
  assert.throws(() => provider.assertResourceUrl("https://other.example/api/mcp"));

  const state = await provider.state();
  assert.equal(state, "state-value-that-is-long-enough");
  await provider.saveCodeVerifier("v".repeat(64));
  assert.equal(await provider.codeVerifier(), "v".repeat(64));

  await provider.redirectToAuthorization(new URL("https://auth.example/consent"));
  assert.deepEqual(redirects, ["https://auth.example/consent"]);

  const context = { issuer: "https://auth.example/" };
  await provider.saveClientInformation({ client_id: "public-client" }, context);
  assert.equal((await provider.clientInformation(context)).client_id, "public-client");

  await provider.saveTokens({
    access_token: "access-one",
    refresh_token: "refresh-one",
    token_type: "Bearer",
  }, context);
  assert.equal((await provider.tokens()).refresh_token, "refresh-one");
  assert.equal((await provider.tokens()).scope, "mcp:read mcp:racp");
  await provider.saveTokens({
    access_token: "access-two",
    refresh_token: "refresh-two",
    token_type: "Bearer",
  }, context);
  assert.equal((await provider.tokens(context)).refresh_token, "refresh-two");

  await provider.validateAuthorizationCallback(
    new URLSearchParams({ state: "state-value-that-is-long-enough" }),
  );
  await assert.rejects(() =>
    provider.validateAuthorizationCallback(
      new URLSearchParams({ state: "state-value-that-is-long-enough" }),
    ),
  );
  await provider.invalidateCredentials("tokens");
  assert.equal(await provider.tokens(), undefined);
});

test("OAuth provider rejects non-loopback HTTP redirects", () => {
  assert.throws(() =>
    new RacpMcpOAuthProvider({
      resourceUrl: "https://tenant.example.com/api/mcp",
      redirectUrl: "http://example.com/callback",
      storage: new MemorySecureStorage(),
      storageNamespace: "tenant-example:@worker",
      redirectToAuthorization() {},
    }),
  );
  assert.throws(() =>
    new RacpMcpOAuthProvider({
      resourceUrl: "https://tenant.example.com/api/mcp",
      redirectUrl: "http://localhost:49152/callback",
      storage: new MemorySecureStorage(),
      storageNamespace: "tenant-example:@worker",
      redirectToAuthorization() {},
    }),
  );
});

test("OAuth storage keys are partitioned by resource and explicit identity", async () => {
  const storage = new MemorySecureStorage();
  const common = {
    redirectUrl: "http://127.0.0.1:49152/callback",
    storage,
    storageNamespace: "principal:@worker",
    redirectToAuthorization() {},
  };
  const first = new RacpMcpOAuthProvider({
    ...common,
    resourceUrl: "https://one.example/api/mcp",
  });
  const second = new RacpMcpOAuthProvider({
    ...common,
    resourceUrl: "https://two.example/api/mcp",
  });
  await first.saveTokens({
    access_token: "first-access",
    refresh_token: "first-refresh",
    token_type: "Bearer",
  });
  await second.saveTokens({
    access_token: "second-access",
    refresh_token: "second-refresh",
    token_type: "Bearer",
  });
  assert.equal((await first.tokens()).refresh_token, "first-refresh");
  assert.equal((await second.tokens()).refresh_token, "second-refresh");
  assert.equal(storage.values.size, 2);
});

test("OAuth refresh operations use one storage-backed exclusive lock", async () => {
  const storage = new MemorySecureStorage();
  const options = {
    resourceUrl: "https://tenant.example.com/api/mcp",
    redirectUrl: "http://127.0.0.1:49152/callback",
    storage,
    storageNamespace: "principal:@worker",
    redirectToAuthorization() {},
  };
  const first = new RacpMcpOAuthProvider(options);
  const second = new RacpMcpOAuthProvider(options);
  let active = 0;
  let maximum = 0;
  const operation = (provider) => provider.runAuthorizationExclusive(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });
  await Promise.all([operation(first), operation(second)]);
  assert.equal(maximum, 1);
});

test("OAuth token scope fallback records only the scopes actually requested", async () => {
  const provider = new RacpMcpOAuthProvider({
    resourceUrl: "https://tenant.example.com/api/mcp",
    redirectUrl: "http://127.0.0.1:49152/callback",
    storage: new MemorySecureStorage(),
    storageNamespace: "principal:@worker-with-extra-metadata",
    scopes: ["offline_access"],
    redirectToAuthorization() {},
  });
  assert.match(provider.clientMetadata.scope, /offline_access/);
  await provider.saveTokens({
    access_token: "access",
    refresh_token: "refresh",
    token_type: "Bearer",
  });
  assert.equal((await provider.tokens()).scope, "mcp:read mcp:racp");
});

test("hosted OAuth proactively requests read and RACP scopes before MCP bootstrap", async () => {
  const redirects = [];
  const registrations = [];
  const provider = new RacpMcpOAuthProvider({
    resourceUrl: "https://tenant.example.com/api/mcp",
    redirectUrl: "http://127.0.0.1:49152/callback",
    storage: new MemorySecureStorage(),
    storageNamespace: "tenant-example:@worker",
    redirectToAuthorization: (url) => redirects.push(url),
    stateFactory: () => "scope-test-state-value-long-enough",
  });
  const fetchMock = async (input, init = {}) => {
    const url = new URL(
      input instanceof URL ? input.toString() :
        typeof input === "string" ? input : input.url,
    );
    if (url.pathname === "/.well-known/oauth-protected-resource/api/mcp") {
      return Response.json({
        resource: "https://tenant.example.com/api/mcp",
        authorization_servers: ["https://auth.example.com"],
        scopes_supported: ["mcp:read", "mcp:racp"],
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        registration_endpoint: "https://auth.example.com/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["mcp:read", "mcp:racp"],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (url.pathname === "/register") {
      const body = JSON.parse(String(init.body));
      registrations.push(body);
      return Response.json({
        ...body,
        client_id: "racp-public-client",
      }, { status: 201 });
    }
    throw new Error(`Unexpected OAuth request: ${url}`);
  };
  const mcp = new RacpMcpClient(
    "https://tenant.example.com/api/mcp",
    {
      kind: "oauth",
      provider,
      validateAuthorizationCallback: (params) =>
        provider.validateAuthorizationCallback(params),
    },
    { fetch: fetchMock },
  );

  await assert.rejects(
    () => mcp.connect(),
    (error) => error?.code === "RACP_OAUTH_AUTHORIZATION_REQUIRED",
  );
  assert.equal(registrations.length, 1);
  assert.deepEqual(new Set(registrations[0].scope.split(" ")), new Set([
    "mcp:read",
    "mcp:racp",
  ]));
  assert.equal(redirects.length, 1);
  assert.deepEqual(new Set(redirects[0].searchParams.get("scope").split(" ")), new Set([
    "mcp:read",
    "mcp:racp",
  ]));
});

test("stale MCP connection cleanup cannot clear a newer connection", async () => {
  const mcp = new RacpMcpClient(
    "https://tenant.example.com/api/mcp",
    { kind: "provider", provider: { async token() { return "token"; } } },
  );
  let oldClosed = 0;
  const oldClient = { async close() { oldClosed += 1; } };
  const oldTransport = { async close() {} };
  const newClient = { async close() {} };
  const newTransport = { async close() {} };
  const newConnect = Promise.resolve();
  mcp.client = newClient;
  mcp.transport = newTransport;
  mcp.connectPromise = newConnect;

  await mcp.resetConnection(oldClient, oldTransport);

  assert.equal(oldClosed, 1);
  assert.equal(mcp.client, newClient);
  assert.equal(mcp.transport, newTransport);
  assert.equal(mcp.connectPromise, newConnect);
});
