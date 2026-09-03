import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { managedMcpServers } from "../src/managed-agent-tools.mjs";

test("ProVIBot mounts Alder and Slack while Services remains ordinary HTTPS", () => {
  const servers = managedMcpServers({
    alderMcpUrl: "https://app.alder.exchange/mcp",
  });
  assert.deepEqual(servers.map((server) => server.name), ["alder", "slack"]);
});

test("owner establishment stays in the encrypted enrollment handoff", async () => {
  const [manifest, lockfile, run, enrollment, renew, shared, ingressDeploy, receiverDeploy, vaultCredential] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("package-lock.json", "utf8"),
    readFile("src/run.mjs", "utf8"),
    readFile("src/service-payment-enrollment.mjs", "utf8"),
    readFile("src/renew.mjs", "utf8"),
    readFile("src/shared.mjs", "utf8"),
    readFile("src/deploy-slack-ingress.mjs", "utf8"),
    readFile("slack-events/deploy.mjs", "utf8"),
    readFile("src/alder-mcp-vault-credential.mjs", "utf8"),
  ]);
  assert.match(manifest, /"@alderinc\/sdk": "0\.1\.4"/);
  assert.match(lockfile, /"version": "0\.1\.4"/);
  assert.match(enrollment, /initialServicePayment/);
  assert.match(enrollment, /mode: "managed_session"/);
  assert.match(enrollment, /\/connections/);
  assert.match(enrollment, /\/connections\/managed-session-quote/);
  assert.match(enrollment, /paymentGrantCapNanodollars/);
  assert.doesNotMatch(enrollment, /PROVIBOT_INITIAL_SERVICE_GRANT_CAP_NANODOLLARS/);
  assert.match(enrollment, /x-alder-payment-grant/);
  assert.match(enrollment, /initial admission exceeded the pre-establishment quote/);
  assert.doesNotMatch(enrollment, /requiredServices/);
  assert.match(run, /recoverExistingServicesAccess/);
  assert.match(run, /syncAlderMcpVaultCredential/);
  assert.match(renew, /syncAlderMcpVaultCredential/);
  assert.match(vaultCredential, /credentials\.scopes\.join\(" "\)/);
  assert.match(vaultCredential, /refusing to create a second credential/);
  assert.match(vaultCredential, /mcp_oauth_validate/);
  assert.doesNotMatch(run, /"launcher"/);
  assert.match(run, /"standard"/);
  assert.doesNotMatch(run, /x-alder-payment-grant/);
  assert.match(run, /serviceConnectionEstablishedAt/);
  assert.match(enrollment, /bundle\.credentials\?\.alderMcp/);
  assert.match(enrollment, /findExistingServicesConnection/);
  assert.match(enrollment, /recoverExistingServicesAccess/);
  assert.match(enrollment, /recovery-proofs/);
  assert.match(enrollment, /connections\/recover/);
  assert.match(renew, /recoverExistingServicesAccess/);
  assert.match(renew, /findExistingServicesConnection/);
  assert.match(renew, /servicesControl\.sat/);
  assert.match(renew, /Alder identity is lifecycle-only/);
  assert.match(renew, /owner launch establishment flow before renewal/);
  assert.doesNotMatch(renew, /establish:\s*true/);
  assert.doesNotMatch(renew, /currentServiceConnection/);
  assert.doesNotMatch(enrollment, /owner-selected cap/);
  assert.doesNotMatch(renew, /x-alder-payment-grant/);
  assert.doesNotMatch(run, /previewAuthHeader|ALDER_BASIC_AUTH|ALDER_SERVICES_LEGACY/);
  assert.doesNotMatch(run, /\$\{servicesUrl\}\/mcp/);
  assert.doesNotMatch(shared, /preview-authorization|LEGACY_CONTROL/);
  assert.match(ingressDeploy, /recoverIngressServicesAccess/);
  assert.match(ingressDeploy, /PROVIBOT_INGRESS_SAT_FILE/);
  assert.match(ingressDeploy, /pmaConnectionReused: true/);
  assert.match(receiverDeploy, /PROVIBOT_INGRESS_SAT_FILE/);
  assert.doesNotMatch(receiverDeploy, /app\.alder\.exchange|\/oauth\/token|ALDER_ORG_API_KEY|recovery-proofs/);
});

test("normal Services recovery keeps the independent ingress profile available", async () => {
  const [enrollment, run, ingressDeploy] = await Promise.all([
    readFile("src/service-payment-enrollment.mjs", "utf8"),
    readFile("src/run.mjs", "utf8"),
    readFile("src/deploy-slack-ingress.mjs", "utf8"),
  ]);
  assert.match(enrollment, /profile = "standard"/);
  assert.match(run, /recoverExistingServicesAccess\(controlCredentials, null, "standard"\)/);
  assert.match(enrollment, /recoverExistingServicesAccess\(controlCredentials, knownConnection, "ingress"\)/);
  assert.match(ingressDeploy, /recoverIngressServicesAccess/);
  assert.doesNotMatch(ingressDeploy, /recoverExistingServicesAccess\([^\n]*"standard"/);
});
