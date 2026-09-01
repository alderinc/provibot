import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { fullManagedAgentTools, managedMcpServers } from "../src/managed-agent-tools.mjs";

test("ProVIBot mounts only the read-only Services capacity capability", () => {
  const servers = managedMcpServers({
    alderMcpUrl: "https://app.alder.exchange/mcp",
    alderServicesUrl: "https://services.alder.exchange",
  });
  assert.deepEqual(servers.map((server) => server.name), ["alder", "alder-session-capacity", "slack"]);
  const capacity = fullManagedAgentTools(servers).find((tool) => tool.mcp_server_name === "alder-session-capacity");
  assert.deepEqual(capacity.configs.map((config) => config.name), ["getManagedSessionCapacity"]);
  assert.equal(capacity.default_config.enabled, false);
});

test("owner establishment stays in the encrypted enrollment handoff", async () => {
  const [run, enrollment, renew, shared] = await Promise.all([
    readFile("src/run.mjs", "utf8"),
    readFile("src/service-payment-enrollment.mjs", "utf8"),
    readFile("src/renew.mjs", "utf8"),
    readFile("src/shared.mjs", "utf8"),
  ]);
  assert.match(enrollment, /initialServicePayment/);
  assert.match(enrollment, /initialServicePayment: initialManagedSessionPayment/);
  assert.match(run, /x-alder-payment-grant/);
  assert.match(run, /serviceConnectionEstablishedAt/);
  assert.match(enrollment, /bundle\.credentials\?\.alderMcp/);
  assert.match(renew, /item\?\.status === "active"/);
  assert.doesNotMatch(renew, /item\?\.state === "active"/);
  assert.doesNotMatch(run, /previewAuthHeader|ALDER_BASIC_AUTH|ALDER_SERVICES_LEGACY/);
  assert.doesNotMatch(shared, /preview-authorization|LEGACY_CONTROL/);
});
