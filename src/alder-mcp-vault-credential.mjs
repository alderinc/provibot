import { createHash } from "node:crypto";

import { alderMcpUrl, alderUrl } from "./endpoints.mjs";

function listedItems(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.credentials)) return payload.credentials;
  return [];
}

function fingerprint(accessToken) {
  return createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}

export function alderMcpCredential(credentials, runId) {
  return {
    display_name: `Alder MCP ${new URL(alderMcpUrl).hostname}`,
    metadata: { provibotRunId: runId },
    auth: {
      type: "mcp_oauth",
      access_token: credentials.accessToken,
      expires_at: credentials.accessTokenExpiresAt,
      mcp_server_url: alderMcpUrl,
      refresh: {
        client_id: credentials.clientId,
        refresh_token: credentials.refreshToken,
        token_endpoint: `${alderUrl}/oauth/token`,
        token_endpoint_auth: { type: "client_secret_basic", client_secret: credentials.clientSecret },
        resource: credentials.resource,
        scope: credentials.scopes.join(" "),
      },
    },
  };
}

function alderMcpCredentialUpdate(credentials) {
  // The Vault's MCP OAuth update schema deliberately treats the MCP URL,
  // client ID, token endpoint, and resource as immutable. Sending creation
  // fields here makes the vendor reject an otherwise valid scope upgrade.
  return {
    type: "mcp_oauth",
    access_token: credentials.accessToken,
    expires_at: credentials.accessTokenExpiresAt,
    refresh: {
      refresh_token: credentials.refreshToken,
      scope: credentials.scopes.join(" "),
      token_endpoint_auth: { type: "client_secret_basic", client_secret: credentials.clientSecret },
    },
  };
}

/**
 * Upgrade the one existing Alder MCP credential in place. The hosted runtime
 * may use that credential, but it never exposes its bearer or refresh family
 * to the model. Scope additions therefore have to be applied by this local
 * owner-side reconciliation instead of asking the agent to re-authorize.
 */
export async function syncAlderMcpVaultCredential({ control, credentials, state }) {
  const nextFingerprint = fingerprint(credentials.accessToken);
  if (state.alderMcpCredentialFingerprint === nextFingerprint && state.hosted.alderMcpCredentialId) return state;

  const items = listedItems(await control("GET", `/vaults/${encodeURIComponent(state.hosted.vaultId)}/credentials`));
  const expectedName = `Alder MCP ${new URL(alderMcpUrl).hostname}`;
  const credential = items.find((candidate) => candidate?.id === state.hosted.alderMcpCredentialId)
    ?? items.find((candidate) => candidate?.auth?.mcp_server_url === alderMcpUrl)
    ?? items.find((candidate) => candidate?.display_name === expectedName);
  if (!credential?.id) {
    throw new Error("ProVIBot Vault does not contain its Alder MCP credential; refusing to create a second credential");
  }

  const auth = alderMcpCredentialUpdate(credentials);
  await control(
    "POST",
    `/vaults/${encodeURIComponent(state.hosted.vaultId)}/credentials/${encodeURIComponent(credential.id)}`,
    { auth },
    `provibot:${state.runId}:alder-mcp-credential:${nextFingerprint}`,
  );
  await control(
    "POST",
    `/vaults/${encodeURIComponent(state.hosted.vaultId)}/credentials/${encodeURIComponent(credential.id)}/mcp_oauth_validate`,
    {},
    `provibot:${state.runId}:alder-mcp-validate:${nextFingerprint}`,
  );
  return {
    ...state,
    hosted: { ...state.hosted, alderMcpCredentialId: credential.id },
    alderMcpCredentialFingerprint: nextFingerprint,
  };
}
