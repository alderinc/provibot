import { createHash } from "node:crypto";

import { fullManagedAgentTools, managedMcpServers } from "./managed-agent-tools.mjs";
import { persona } from "./persona.mjs";

/**
 * Apply the one standing policy contract to both the hosted agent and the
 * current session. A replacement session does not inherit this configuration
 * implicitly, so renewal must call this before it becomes the durable target
 * for Slack activation.
 */
export async function configureStandingRuntime({ alderMcpUrl, control, state }) {
  const system = persona();
  const systemHash = createHash("sha256").update(system).digest("hex").slice(0, 16);
  const mcpServers = managedMcpServers({ alderMcpUrl });
  const tools = fullManagedAgentTools(mcpServers);
  await control(
    "POST",
    `/agents/${encodeURIComponent(state.hosted.agentId)}`,
    { name: "ProVIBot", system, mcp_servers: mcpServers, tools },
    `provibot:${state.runId}:standing-agent:${systemHash}`,
  );
  await control(
    "POST",
    `/sessions/${encodeURIComponent(state.hosted.sessionId)}`,
    { agent: { mcp_servers: mcpServers, tools } },
    `provibot:${state.runId}:standing-session-tools:${systemHash}`,
  );
  return systemHash;
}
