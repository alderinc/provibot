import assert from "node:assert/strict";
import test from "node:test";

import { syncAlderMcpVaultCredential } from "../src/alder-mcp-vault-credential.mjs";

test("upgrades the existing Alder MCP credential in place and stays idempotent", async () => {
  const calls = [];
  const state = {
    runId: "provi-test",
    hosted: { vaultId: "vlt_test", alderMcpCredentialId: "cred_alder" },
  };
  const credentials = {
    accessToken: "access-token-with-write-scope",
    accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
    clientId: "client_test",
    clientSecret: "secret_test",
    refreshToken: "refresh_test",
    resource: "https://app.alder.exchange/mcp",
    scopes: ["wallet:read", "payments:read", "payments:write"],
  };
  const control = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET") return { data: [{ id: "cred_alder", auth: { mcp_server_url: "https://app.alder.exchange/mcp" } }] };
    if (path.endsWith("/mcp_oauth_validate")) return { valid: true };
    if (path.endsWith("/credentials/cred_alder")) return { id: "cred_alder" };
    throw new Error(`unexpected ${method} ${path}`);
  };

  const updated = await syncAlderMcpVaultCredential({ control, credentials, state });
  assert.equal(updated.hosted.alderMcpCredentialId, "cred_alder");
  assert.notEqual(updated.alderMcpCredentialFingerprint, undefined);
  assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/vaults/vlt_test/credentials").length, 0);
  const update = calls.find((call) => call.path.endsWith("/credentials/cred_alder"));
  assert.equal(update.body.auth.mcp_server_url, undefined);
  assert.equal(update.body.auth.refresh.client_id, undefined);
  assert.equal(update.body.auth.refresh.token_endpoint, undefined);
  assert.equal(update.body.auth.refresh.resource, undefined);
  assert.match(update.body.auth.refresh.scope, /payments:write/);

  await syncAlderMcpVaultCredential({ control, credentials, state: updated });
  assert.equal(calls.length, 3, "a matching credential fingerprint makes a repeat launch read-free");
});
