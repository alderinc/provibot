import assert from "node:assert/strict";
import test from "node:test";

import { alderMcpUrl } from "../src/endpoints.mjs";
import { configureStandingRuntime } from "../src/standing-runtime.mjs";

test("a replacement session receives the same mounted tool contract as its agent", async () => {
  const calls = [];
  const state = { hosted: { agentId: "agent_123", sessionId: "session_456" }, runId: "run_789" };
  const hash = await configureStandingRuntime({
    alderMcpUrl,
    control: async (...call) => calls.push(call),
    servicesUrl: "https://services.alder.exchange",
    state,
  });
  assert.match(hash, /^[a-f0-9]{16}$/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], "/agents/agent_123");
  assert.equal(calls[1][1], "/sessions/session_456");
  assert.deepEqual(calls[0][2].mcp_servers, calls[1][2].agent.mcp_servers);
  assert.deepEqual(calls[0][2].tools, calls[1][2].agent.tools);
  assert.match(calls[1][3], /standing-session-tools/);
});
