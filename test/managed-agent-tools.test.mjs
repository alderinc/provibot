import assert from "node:assert/strict";
import test from "node:test";

import { fullAgentToolNames, fullManagedAgentTools } from "../src/managed-agent-tools.mjs";

test("full managed-agent profile enables every native tool without weakening MCP access", () => {
  assert.deepEqual(fullAgentToolNames, ["bash", "edit", "read", "write", "glob", "grep", "web_fetch", "web_search"]);

  const tools = fullManagedAgentTools([{ name: "alder" }, { name: "alder-services" }, { name: "slack" }]);
  const [native, ...mcp] = tools;
  assert.deepEqual(native.configs.map(({ name }) => name), fullAgentToolNames);
  for (const tool of native.configs) assert.deepEqual(tool.permission_policy, { type: "always_allow" });
  assert.deepEqual(mcp.map(({ mcp_server_name }) => mcp_server_name), ["alder", "alder-services", "slack"]);
  for (const tool of mcp) assert.deepEqual(tool.default_config, { enabled: true, permission_policy: { type: "always_allow" } });
});
