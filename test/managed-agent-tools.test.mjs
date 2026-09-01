import assert from "node:assert/strict";
import test from "node:test";

import { fullAgentToolNames, fullManagedAgentTools, managedMcpServers } from "../src/managed-agent-tools.mjs";

test("full managed-agent profile enables every native tool without weakening MCP access", () => {
  assert.deepEqual(fullAgentToolNames, ["bash", "edit", "read", "write", "glob", "grep", "web_fetch", "web_search"]);

  const tools = fullManagedAgentTools([{ name: "alder" }, { name: "alder-session-capacity" }, { name: "slack" }]);
  const [native, ...mcp] = tools;
  assert.deepEqual(native.configs.map(({ name }) => name), fullAgentToolNames);
  for (const tool of native.configs) assert.deepEqual(tool.permission_policy, { type: "always_allow" });
  assert.deepEqual(mcp.map(({ mcp_server_name }) => mcp_server_name), ["alder", "alder-session-capacity", "slack"]);
  for (const tool of mcp.filter((tool) => tool.mcp_server_name !== "alder-session-capacity")) {
    assert.deepEqual(tool.default_config, { enabled: true, permission_policy: { type: "always_allow" } });
  }
  const capacity = mcp.find((tool) => tool.mcp_server_name === "alder-session-capacity");
  assert.deepEqual(capacity.default_config, { enabled: false, permission_policy: { type: "always_allow" } });
  assert.deepEqual(capacity.configs.map(({ name }) => name), ["getManagedSessionCapacity", "setUsageWindow"]);
  assert.deepEqual(capacity.configs.map(({ name }) => name).filter((name) => name !== "getManagedSessionCapacity" && name !== "setUsageWindow"), []);
});

test("provider access is external HTTPS; Services MCP exposes only managed-session capacity controls", () => {
  const servers = managedMcpServers({ alderMcpUrl: "https://app.alder.exchange/mcp", alderServicesUrl: "https://services.alder.exchange" });
  assert.deepEqual(servers.map((server) => server.name), ["alder", "alder-session-capacity", "slack"]);
});
