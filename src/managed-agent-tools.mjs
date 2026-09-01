export const fullAgentToolNames = Object.freeze([
  "bash",
  "edit",
  "read",
  "write",
  "glob",
  "grep",
  "web_fetch",
  "web_search",
]);

const alwaysAllow = Object.freeze({ type: "always_allow" });

export function managedMcpServers({ alderMcpUrl, alderServicesUrl }) {
  return [
    { name: "alder", type: "url", url: alderMcpUrl },
    // This is intentionally a one-tool Services mount. Provider operations
    // remain ordinary HTTPS calls authenticated with sat_; the agent gets only
    // the read-only session-capacity fact it needs to follow its doctrine.
    { name: "alder-session-capacity", type: "url", url: `${alderServicesUrl}/mcp` },
    { name: "slack", type: "url", url: "https://mcp.slack.com/mcp" },
  ];
}

export function fullManagedAgentTools(mcpServers) {
  return [
    {
      type: "agent_toolset_20260401",
      default_config: { enabled: false, permission_policy: alwaysAllow },
      configs: fullAgentToolNames.map((name) => ({ name, enabled: true, permission_policy: alwaysAllow })),
    },
    ...mcpServers.map((server) => server.name === "alder-session-capacity"
      ? {
          type: "mcp_toolset",
          mcp_server_name: server.name,
          default_config: { enabled: false, permission_policy: alwaysAllow },
          configs: [{ name: "getManagedSessionCapacity", enabled: true, permission_policy: alwaysAllow }],
        }
      : {
          type: "mcp_toolset",
          mcp_server_name: server.name,
          default_config: { enabled: true, permission_policy: alwaysAllow },
        }),
  ];
}
