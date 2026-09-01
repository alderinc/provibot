import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { OrganizationClient, usdNanodollars } from "@alderinc/sdk";

import { alderMcpUrl, alderServicesUrl, alderUrl } from "./endpoints.mjs";
import { durableMemorySeeds, ensureDurableMemoryStructure } from "./durable-memory.mjs";
import { persona } from "./persona.mjs";
import { decryptEnrollment, managed, previewAuthHeader, refreshCredentials, requestJson, required } from "./shared.mjs";
import { configureStandingRuntime } from "./standing-runtime.mjs";

const servicesUrl = alderServicesUrl;
const servicesResource = alderServicesUrl;
const statePath = new URL("../.local-state/provibot.json", import.meta.url);
const authPath = new URL("../.local-state/provibot-auth.json", import.meta.url);
const identityPath = new URL("../.local-state/provibot-identity.json", import.meta.url);
const slack = {
  accessToken: required("PROVIBOT_SLACK_ACCESS_TOKEN"),
  channelId: required("PROVIBOT_SLACK_CHANNEL_ID"),
  teamId: required("PROVIBOT_SLACK_TEAM_ID"),
  userId: required("PROVIBOT_SLACK_USER_ID"),
};
const organization = new OrganizationClient({
  coreUrl: alderUrl,
  orgApiKey: required("ALDER_ORG_API_KEY"),
  fetch: async (input, init = {}) => {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(previewAuthHeader("ALDER_BASIC_AUTH_USERNAME", "ALDER_BASIC_AUTH_PASSWORD"))) headers.set(name, value);
    return fetch(input, { ...init, headers });
  },
});
let controlCredentials;
let controlAgentId;

const slackUserScopes = [
  "chat:write",
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "files:read",
  "users:read",
  "users:read.email",
];

async function validateSlackUserCredential() {
  const response = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { authorization: `Bearer ${slack.accessToken}` },
  });
  const payload = await response.json().catch(() => null);
  const scopes = new Set((response.headers.get("x-oauth-scopes") ?? "").split(",").map((scope) => scope.trim()).filter(Boolean));
  if (!response.ok || !payload?.ok || payload.team_id !== slack.teamId || payload.user_id !== slack.userId) {
    throw new Error("Slack user credential does not identify the configured ProVIBot user in the configured workspace");
  }
  for (const scope of slackUserScopes) {
    if (!scopes.has(scope)) throw new Error(`Slack user credential lacks ${scope}; run npm run authorize-slack after adding the user scope`);
  }
}

function money(amount) {
  if (!/^\d+$/.test(amount)) throw new Error("money must be an integer nanodollar string");
  return usdNanodollars(BigInt(amount));
}

async function readJson(path, absent = null) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return absent; throw error; }
}

async function writePrivateJson(path, value) {
  // Local state contains durable resource identifiers or renewable control
  // material. It is deliberately private operator state, never a deployment
  // artifact or a substitute for Vault-held credentials.
  await mkdir(new URL("../.local-state/", import.meta.url), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function ensureExistingAgent() {
  // A missing record is the only condition that permits first-time creation.
  // Any partial record is evidence of an interrupted operation, so failing
  // closed preserves the one funded ProVIBot identity and wallet.
  const existing = await readJson(identityPath);
  if (existing?.state === "ready" && typeof existing.agentId === "string" && existing.agentId) return { agentId: existing.agentId, reused: true };
  if (existing) throw new Error("ProVIBot agent creation has an unresolved local checkpoint; refusing to create a second Alder agent");
  await writePrivateJson(identityPath, { state: "creating", startedAt: new Date().toISOString() });
  try {
    const agent = await organization.createAgent({
      callbackUrl: "https://localhost.invalid/provibot",
      description: "Persistent Alder-funded managed agent",
      name: process.env.PROVIBOT_AGENT_NAME?.trim() || "ProVIBot",
    });
    await writePrivateJson(identityPath, { agentId: agent.agentId, createdAt: new Date().toISOString(), state: "ready" });
    return { agentId: agent.agentId, reused: false };
  } catch (error) {
    await writePrivateJson(identityPath, { state: "uncertain", failedAt: new Date().toISOString() });
    throw error;
  }
}

async function ensureControlFresh() {
  // These credentials control the existing managed stack. Refresh or recover
  // that control family, but never use credential trouble to reprovision it.
  if (!controlCredentials) throw new Error("Alder control credentials are not initialized");
  const expiresAt = Date.parse(controlCredentials.accessTokenExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 90_000) {
    try {
      controlCredentials = await refreshCredentials(controlCredentials);
    } catch (error) {
      // A rotating refresh token can be consumed by an interrupted local
      // process. Re-enrolling the same principal restores only this local
      // control family; it never creates a new agent, wallet, Vault, or
      // hosted resource.
      if (!String(error?.message ?? "").includes("HTTP 401") || !controlAgentId) throw error;
      controlCredentials = await recoverControlCredentials(controlAgentId);
    }
    await writePrivateJson(authPath, controlCredentials);
  }
  return controlCredentials.accessToken;
}

function managedServiceRequirement() {
  // The enrollment audience must be the exact Services resource origin. A
  // nearby browser or API URL can produce a valid-looking but unusable token.
  return [{
    role: "cognition",
    resource: servicesResource,
    restBaseUrl: servicesUrl,
    mcpUrl: `${servicesUrl}/mcp`,
    openAiBaseUrl: servicesUrl,
    model: "claude-sonnet-5",
    alderScopes: ["services:read", "services:write"],
    readinessUrl: `${servicesUrl}/models`,
  }];
}

async function recoverControlCredentials(agentId) {
  const installationId = `provibot-control-${randomUUID()}`;
  const enrollment = await organization.createRuntimeEnrollment({
    agentId,
    accessTokenTtlSeconds: 900,
    coreMcpUrl: alderMcpUrl,
    expiresInSeconds: 300,
    requiredServices: managedServiceRequirement(),
    runtime: "managed-session",
  });
  const exchanged = await requestJson(`${alderUrl}/runtime-enrollments/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", ...previewAuthHeader("ALDER_BASIC_AUTH_USERNAME", "ALDER_BASIC_AUTH_PASSWORD") },
    body: JSON.stringify({ enrollmentId: enrollment.enrollmentId, enrollmentSecret: enrollment.enrollmentSecret, installationId }),
  }, "recover ProVIBot control credential");
  const bundle = decryptEnrollment(enrollment.enrollmentSecret, installationId, exchanged.encryptedBundle);
  const credentials = bundle.credentials.services?.[0]?.credentials?.model;
  if (!credentials?.accessToken || !credentials.refreshToken) throw new Error("recovered enrollment did not contain a renewable Services control credential");
  await requestJson(`${alderUrl}/runtime-enrollments/${encodeURIComponent(enrollment.enrollmentId)}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json", ...previewAuthHeader("ALDER_BASIC_AUTH_USERNAME", "ALDER_BASIC_AUTH_PASSWORD") },
    body: JSON.stringify({ enrollmentId: enrollment.enrollmentId, enrollmentSecret: enrollment.enrollmentSecret, installationId }),
  }, "acknowledge recovered ProVIBot control credential");
  return credentials;
}

async function managedControl(method, path, body, idempotencyKey) {
  return managed(method, path, await ensureControlFresh(), body, idempotencyKey);
}

function tokenFingerprint(token) {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function listedItems(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.credentials)) return payload.credentials;
  return [];
}

async function syncSlackVaultCredential(state) {
  const fingerprint = tokenFingerprint(slack.accessToken);
  if (state.slackCredentialFingerprint === fingerprint && state.hosted.slackCredentialId) return state;
  const credentials = listedItems(await managedControl("GET", `/vaults/${encodeURIComponent(state.hosted.vaultId)}/credentials`, undefined, undefined));
  const credential = credentials.find((candidate) => candidate?.id === state.hosted.slackCredentialId)
    ?? credentials.find((candidate) => candidate?.auth?.mcp_server_url === "https://mcp.slack.com/mcp")
    ?? credentials.find((candidate) => candidate?.display_name === `ProVIBot Slack ${slack.teamId}`);
  if (!credential?.id) throw new Error("ProVIBot Vault does not contain its Slack MCP credential; refusing to create a second credential");
  await managedControl(
    "POST",
    `/vaults/${encodeURIComponent(state.hosted.vaultId)}/credentials/${encodeURIComponent(credential.id)}`,
    // mcp_server_url is the credential's immutable Vault lookup key. Updating
    // it makes Anthropic reject the request; only replace the write-only
    // bearer value under the already-pinned Slack MCP credential.
    { auth: { type: "static_bearer", token: slack.accessToken } },
    `provibot:${state.runId}:slack-credential:${fingerprint}`,
  );
  return {
    ...state,
    hosted: { ...state.hosted, slackCredentialId: credential.id },
    slackCredentialFingerprint: fingerprint,
  };
}

function mcpCredential(credentials, mcpUrl, runId) {
  return {
    display_name: `Alder MCP ${new URL(mcpUrl).hostname}`,
    metadata: { provibotRunId: runId },
    auth: {
      type: "mcp_oauth", access_token: credentials.accessToken, expires_at: credentials.accessTokenExpiresAt, mcp_server_url: mcpUrl,
      refresh: { client_id: credentials.clientId, refresh_token: credentials.refreshToken, token_endpoint: `${alderUrl}/oauth/token`, token_endpoint_auth: { type: "client_secret_basic", client_secret: credentials.clientSecret }, resource: credentials.resource, scope: credentials.scopes.join(" ") },
    },
  };
}

async function applyStandingAgentPersona(state) {
  // Keep the hosted agent and its active session on the same tool/policy
  // contract. A changed policy is recorded below and takes effect only through
  // the explicit renewal path; launch must not silently replace a live session.
  return configureStandingRuntime({ alderMcpUrl, control: managedControl, state });
}

async function createHostedStack() {
  // This path is only for a true first deployment. Everything added after the
  // persistent Alder identity is tracked for compensating cleanup on failure;
  // the identity itself is intentionally never part of that cleanup set.
  const runId = `provi-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const agent = await ensureExistingAgent();
  await organization.fundAgent({ agentId: agent.agentId, amountUsd: money(process.env.PROVIBOT_FUNDING_NANODOLLARS ?? "25000000000"), idempotencyKey: `provibot:${agent.agentId}:initial-funding:v1` });
  const enrollment = await organization.createRuntimeEnrollment({
    agentId: agent.agentId, accessTokenTtlSeconds: 900, coreMcpUrl: alderMcpUrl, expiresInSeconds: 300,
    requiredServices: managedServiceRequirement(), runtime: "managed-session",
  });
  const installationId = `provibot-${runId}`;
  const exchanged = await requestJson(`${alderUrl}/runtime-enrollments/exchange`, {
    method: "POST", headers: { "content-type": "application/json", ...previewAuthHeader("ALDER_BASIC_AUTH_USERNAME", "ALDER_BASIC_AUTH_PASSWORD") },
    body: JSON.stringify({ enrollmentId: enrollment.enrollmentId, enrollmentSecret: enrollment.enrollmentSecret, installationId }),
  }, "runtime enrollment exchange");
  const bundle = decryptEnrollment(enrollment.enrollmentSecret, installationId, exchanged.encryptedBundle);
  const service = bundle.credentials.services[0];
  controlCredentials = { ...service.credentials.model };
  await writePrivateJson(authPath, controlCredentials);
  const created = [];
  try {
    const vault = await managedControl("POST", "/vaults", { display_name: "ProVIBot", metadata: { provibotRunId: runId } }, `${runId}:vault`);
    created.push(["vaults", vault.id]);
    const { coreMcp: alderMcpCredentials } = bundle.credentials;
    for (const [credentials, url] of [[alderMcpCredentials, alderMcpUrl]]) {
      const credential = await managedControl("POST", `/vaults/${vault.id}/credentials`, mcpCredential(credentials, url, runId), `${runId}:mcp:${created.length}`);
      created.push([`vaults/${vault.id}/credentials`, credential.id]);
      await managedControl("POST", `/vaults/${vault.id}/credentials/${credential.id}/mcp_oauth_validate`, {}, `${runId}:mcp-validate:${credential.id}`);
    }
    const slackCredential = await managedControl("POST", `/vaults/${vault.id}/credentials`, { display_name: `ProVIBot Slack ${slack.teamId}`, metadata: { channelId: slack.channelId, provibotRunId: runId }, auth: { type: "static_bearer", token: slack.accessToken, mcp_server_url: "https://mcp.slack.com/mcp" } }, `${runId}:slack`);
    created.push([`vaults/${vault.id}/credentials`, slackCredential.id]);
    const memory = await managedControl("POST", "/memory_stores", { name: "ProVIBot memory", description: "Authoritative durable summaries of requests, decisions, blockers, and completed work.", metadata: { provibotRunId: runId } }, `${runId}:memory`);
    created.push(["memory_stores", memory.id]);
    for (const [path, content] of durableMemorySeeds) {
      const seededMemory = await managedControl("POST", `/memory_stores/${memory.id}/memories`, { path, content }, `${runId}:memory:${createHash("sha256").update(path).digest("hex").slice(0, 12)}`);
      created.push([`memory_stores/${memory.id}/memories`, seededMemory.id]);
    }
    const environment = await managedControl("POST", "/environments", { name: "ProVIBot", config: { type: "cloud", networking: { type: "limited", allowed_hosts: [new URL(alderMcpUrl).hostname, new URL(servicesUrl).hostname, "mcp.slack.com"].sort(), allow_mcp_servers: true, allow_package_managers: false } }, metadata: { provibotRunId: runId } }, `${runId}:environment`);
    created.push(["environments", environment.id]);
    const mcpServers = managedMcpServers({ alderMcpUrl });
    const hostedAgent = await managedControl("POST", "/agents", { name: "ProVIBot", model: "claude-sonnet-5", mcp_servers: mcpServers, tools: fullManagedAgentTools(mcpServers), system: persona(), metadata: { provibotRunId: runId } }, `${runId}:agent`);
    created.push(["agents", hostedAgent.id]);
    const session = await managedControl("POST", "/sessions", { agent: hostedAgent.id, environment_id: environment.id, vault_ids: [vault.id], resources: [{ type: "memory_store", memory_store_id: memory.id, access: "read_write", instructions: "Read this durable task record before work and update it after meaningful progress or completion." }], metadata: { provibotRunId: runId }, title: "ProVIBot" }, `${runId}:session`);
    created.push(["sessions", session.id]);
    await requestJson(`${alderUrl}/runtime-enrollments/${encodeURIComponent(enrollment.enrollmentId)}/ack`, { method: "POST", headers: { "content-type": "application/json", ...previewAuthHeader("ALDER_BASIC_AUTH_USERNAME", "ALDER_BASIC_AUTH_PASSWORD") }, body: JSON.stringify({ enrollmentId: enrollment.enrollmentId, enrollmentSecret: enrollment.enrollmentSecret, installationId }) }, "runtime enrollment acknowledgment");
    return {
      alderAgentId: agent.agentId,
      runId,
      reusedAlderAgent: agent.reused,
      hosted: { agentId: hostedAgent.id, environmentId: environment.id, memoryStoreId: memory.id, sessionId: session.id, slackCredentialId: slackCredential.id, vaultId: vault.id },
      lessonsReferenceClassVersion: 1,
      memoryStructureVersion: 2,
      slackCredentialFingerprint: tokenFingerprint(slack.accessToken),
      standingPersonaHash: createHash("sha256").update(persona()).digest("hex").slice(0, 16),
    };
  } catch (error) {
    // Reverse only resources created in this attempt. Existing Alder identity,
    // wallet, and any prior hosted stack remain outside this failure boundary.
    for (const [collection, id] of [...created].reverse()) await managedControl(collection === "agents" ? "POST" : "DELETE", `/${collection}/${encodeURIComponent(id)}${collection === "agents" ? "/archive" : ""}`, collection === "agents" ? {} : undefined, `${runId}:cleanup:${id}`).catch(() => undefined);
    throw error;
  }
}

async function loadOrCreateState() {
  const state = await readJson(statePath);
  if (state?.hosted?.sessionId && state?.alderAgentId) {
    // A normal launch reconciles the existing stack only. Policy changes leave
    // an explicit checkpoint and require `npm run renew`, preserving the
    // session boundary and preventing an implicit duplicate runtime.
    controlAgentId = state.alderAgentId;
    controlCredentials = await readJson(authPath);
    if (!controlCredentials) throw new Error("ProVIBot state exists without renewable control credentials; run npm run stop before reprovisioning");
    let updated = await syncSlackVaultCredential(state);
    updated = await ensureDurableMemoryStructure({ control: managedControl, state: updated });
    const systemHash = await applyStandingAgentPersona(updated);
    if (updated.standingPersonaHash !== systemHash) {
      updated = { ...updated, pendingPersonaHash: systemHash };
      await writePrivateJson(statePath, updated);
      throw new Error("ProVIBot agent policy changed; run npm run renew to start one replacement session with the updated policy");
    }
    if (JSON.stringify(updated) !== JSON.stringify(state)) await writePrivateJson(statePath, updated);
    return updated;
  }
  const created = await createHostedStack();
  await writePrivateJson(statePath, { schema: "alder.provibot-local/v2", createdAt: new Date().toISOString(), ...created });
  return created;
}

await validateSlackUserCredential();
const state = await loadOrCreateState();
console.log(JSON.stringify({ event: "provibot.ready", sessionId: state.hosted.sessionId, activation: "slack-events" }));
