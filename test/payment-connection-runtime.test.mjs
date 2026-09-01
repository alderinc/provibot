import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { fullManagedAgentTools, managedMcpServers } from "../src/managed-agent-tools.mjs";

test("ProVIBot mounts only the bounded Services capacity capabilities", () => {
  const servers = managedMcpServers({
    alderMcpUrl: "https://app.alder.exchange/mcp",
    alderServicesUrl: "https://services.alder.exchange",
  });
  assert.deepEqual(servers.map((server) => server.name), ["alder", "alder-session-capacity", "slack"]);
  const capacity = fullManagedAgentTools(servers).find((tool) => tool.mcp_server_name === "alder-session-capacity");
  assert.deepEqual(capacity.configs.map((config) => config.name), ["getManagedSessionCapacity", "setUsageWindow"]);
  assert.equal(capacity.default_config.enabled, false);
});

test("owner establishment stays in the encrypted enrollment handoff", async () => {
  const [manifest, lockfile, run, enrollment, renew, shared] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("package-lock.json", "utf8"),
    readFile("src/run.mjs", "utf8"),
    readFile("src/service-payment-enrollment.mjs", "utf8"),
    readFile("src/renew.mjs", "utf8"),
    readFile("src/shared.mjs", "utf8"),
  ]);
  assert.match(manifest, /"@alderinc\/sdk": "0\.1\.4"/);
  assert.match(lockfile, /"version": "0\.1\.4"/);
  assert.match(enrollment, /initialServicePayment/);
  assert.match(enrollment, /quoteManagedSessionAdmission/);
  assert.match(enrollment, /agent-instances\/admission-quote/);
  assert.match(enrollment, /paymentGrantCapNanodollars/);
  assert.match(enrollment, /does not cover the complete first required hold/);
  assert.match(enrollment, /installationId: `\$\{installationId\}-admission-quote`/);
  assert.match(enrollment, /await preflight\.acknowledge\(\)/);
  assert.doesNotMatch(enrollment, /PROVIBOT_INITIAL_MANAGED_SESSION_NANODOLLARS/);
  assert.match(run, /x-alder-payment-grant/);
  assert.match(run, /serviceConnectionEstablishedAt/);
  assert.match(enrollment, /bundle\.credentials\?\.alderMcp/);
  assert.match(renew, /item\?\.status === "active"/);
  assert.doesNotMatch(renew, /item\?\.state === "active"/);
  assert.doesNotMatch(run, /previewAuthHeader|ALDER_BASIC_AUTH|ALDER_SERVICES_LEGACY/);
  assert.doesNotMatch(shared, /preview-authorization|LEGACY_CONTROL/);
});
