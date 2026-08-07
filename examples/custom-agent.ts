import {
  RACP_INTENT_CODES,
  createRacpAgent,
  racp_discover,
  racp_query,
  racp_task_create,
} from "@rnby/racp-agent";
import { LocalMemoryAdapter } from "./local-adapter.js";

const adapter = new LocalMemoryAdapter([
  {
    name: "@planner",
    status: "online",
    capabilities: { "planning.breakdown": true },
  },
  {
    name: "@worker",
    status: "online",
    capabilities: { functions: ["code.review", "code.change"] },
  },
]);

const agent = createRacpAgent({ agentName: "@planner", adapter });

agent.onMessage((message) => {
  console.log(message.intent, new TextDecoder().decode(message.payload));
  return "acknowledged";
});

agent.onError((error) => console.error(error.code, error.message));
agent.onStateChange((state) => console.log("state", state));

await agent.start();

const peers = await racp_discover(agent, { capability: "code.review" });
console.log("reviewers", peers.map((peer) => peer.name));

const task = await racp_task_create(agent, {
  capability: "code.review",
  metadata: { objective: "Review the public adapter contract" },
});

await racp_query(agent, {
  capability: "code.review",
  taskId: task.id,
  payload: new TextEncoder().encode("Review this adapter boundary."),
  metadata: { example: true },
});

await agent.send({
  toAgent: "@worker",
  intent: RACP_INTENT_CODES.STATUS,
  payload: new TextEncoder().encode("Example complete."),
});

await agent.stop();
