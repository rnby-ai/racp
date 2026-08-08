import {
  RacpMcpOAuthProvider,
  createHostedRacpAgent,
  type RacpMcpOAuthStorage,
} from "@rnby/racp-agent";

// Back this interface with Keychain, Credential Manager, Secret Service, or
// another atomic encrypted store. `runExclusive()` must lock across processes
// sharing a namespace for the complete refresh/rotation operation. Refresh
// tokens must not enter a plain config file, environment variable, command
// argument, or application log.
declare const secureStorage: RacpMcpOAuthStorage;
declare function openBrowser(url: URL): Promise<void>;
declare function waitForLoopbackCallback(): Promise<URL>;

const tenantSlug = process.env.RNBY_TENANT_SLUG;
if (
  !tenantSlug ||
  !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tenantSlug)
) {
  throw new Error("Set RNBY_TENANT_SLUG to the slug from your RnBy workspace URL.");
}
const mcpUrl = `https://${tenantSlug}.rnby.ai/api/mcp`;
let authorizationRedirected = false;
const oauth = new RacpMcpOAuthProvider({
  resourceUrl: mcpUrl,
  redirectUrl: "http://127.0.0.1:49152/callback",
  storage: secureStorage,
  storageNamespace: `${tenantSlug}:@reviewer`,
  redirectToAuthorization: async (url) => {
    authorizationRedirected = true;
    await openBrowser(url);
  },
});

const agent = createHostedRacpAgent({
  agentName: "@reviewer",
  tenantSlug,
  machine: "reviewer-laptop",
  mcpUrl,
  oauth,
  capabilities: { functions: ["code.review"] },
});

agent.onMessage((message) => {
  console.log(new TextDecoder().decode(message.payload));
  return "acknowledged";
});

agent.onTaskUpdate((event) => {
  console.log(event.position, event.taskId, event.status);
});

try {
  await agent.start();
} catch (error) {
  if (!authorizationRedirected) throw error;
  const callback = await waitForLoopbackCallback();
  await agent.finishOAuthAuthorization(callback);
  await agent.start();
}
