import { readFile, rename, writeFile } from "node:fs/promises";

import { alderMcpUrl, alderServicesUrl, alderUrl } from "./endpoints.mjs";
import { ensureDurableMemoryStructure } from "./durable-memory.mjs";
import { managed, refreshCredentials, requestJson, required } from "./shared.mjs";
import { ownerServiceEnrollment } from "./service-payment-enrollment.mjs";
import { configureStandingRuntime } from "./standing-runtime.mjs";

const stateUrl = new URL("../.local-state/provibot.json", import.meta.url);
const pendingStateUrl = new URL("../.local-state/provibot.json.renewing", import.meta.url);
const authUrl = new URL("../.local-state/provibot-auth.json", import.meta.url);
let state = JSON.parse(await readFile(stateUrl, "utf8"));
let credentials = JSON.parse(await readFile(authUrl, "utf8"));

async function writeState(next) {
  // Persist each renewal transition atomically. If the process stops between
  // close and replacement, the next run resumes the same renewal rather than
  // creating another session or losing the prior session reference.
  await writeFile(pendingStateUrl, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(pendingStateUrl, stateUrl);
  state = next;
}

async function controlToken() {
  const expiresAt = Date.parse(credentials.accessTokenExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 90_000) {
    credentials = await refreshCredentials(credentials);
    await writeFile(authUrl, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
  }
  return credentials.accessToken;
}

async function control(method, path, body, idempotencyKey) {
  return managed(method, path, await controlToken(), body, idempotencyKey);
}

async function currentServiceConnection() {
  const payload = await requestJson(`${alderUrl}/agent/merchant-connections`, {
    headers: { authorization: `Bearer ${await controlToken()}` },
    method: "GET",
  }, "read existing Alder Services connection");
  const merchantApplicationId = required("ALDER_SERVICES_MERCHANT_APPLICATION_ID");
  return Array.isArray(payload?.items)
    ? payload.items.find((item) => item?.merchantApplicationId === merchantApplicationId && item?.status === "active") ?? null
    : null;
}

if (!state?.alderAgentId || !state?.hosted?.agentId || !state?.hosted?.environmentId || !state?.hosted?.memoryStoreId || !state?.hosted?.sessionId || !state?.hosted?.vaultId) {
  throw new Error("ProVIBot hosted state is incomplete; refusing to renew into a second identity");
}

// Owner-side renewal first obtains an ordinary Alder credential. It is used
// only to discover whether the persistent relationship already exists; this
// never lets the agent establish its own first pma_.
const ownerEnrollment = await ownerServiceEnrollment({
  agentId: state.alderAgentId,
  establish: false,
  installationId: `provibot-renew-control-${Date.now()}`,
});
credentials = ownerEnrollment.controlCredentials;
await writeFile(authUrl, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
const existingConnection = await currentServiceConnection();
let establishment = null;
if (!existingConnection) {
  // This is the one owner-only bootstrap for a pre-connection deployment.
  // The raw grant remains solely inside this short-lived encrypted bundle.
  establishment = await ownerServiceEnrollment({
    agentId: state.alderAgentId,
    establish: true,
    installationId: `provibot-renew-establish-${Date.now()}`,
  });
  credentials = establishment.controlCredentials;
  await writeFile(authUrl, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
}

const seeded = await ensureDurableMemoryStructure({ control, state });
if (seeded !== state) await writeState(seeded);

let renewal = state.sessionRenewal;
if (!renewal) {
  renewal = { previousSessionId: state.hosted.sessionId, startedAt: new Date().toISOString(), state: "closing" };
  await writeState({ ...state, sessionRenewal: renewal });
}

if (renewal.state === "closing") {
  // Services captures authoritative supplier usage and releases unused capacity
  // before deletion. The durable checkpoint makes retry safe after interruption.
  await control("DELETE", `/sessions/${encodeURIComponent(renewal.previousSessionId)}`, undefined, `provibot:${state.runId}:renew:${renewal.previousSessionId}:close`);
  renewal = { ...renewal, closedAt: new Date().toISOString(), state: "closed" };
  await writeState({ ...state, sessionRenewal: renewal });
}

if (renewal.state !== "closed") throw new Error(`ProVIBot session renewal checkpoint is invalid: ${renewal.state}`);

// Create the replacement only after final capture/release for the prior
// session completes. The Alder agent, wallet, Vault, environment, and memory
// store stay constant across this deliberately explicit session boundary.
const session = await managed("POST", "/sessions", await controlToken(), {
  agent: state.hosted.agentId,
  environment_id: state.hosted.environmentId,
  vault_ids: [state.hosted.vaultId],
  resources: [{ type: "memory_store", memory_store_id: state.hosted.memoryStoreId, access: "read_write", instructions: "Read this durable task record before work and update it after meaningful progress or completion." }],
  metadata: { provibotRunId: state.runId },
  title: "ProVIBot",
}, `provibot:${state.runId}:renew:${renewal.previousSessionId}:session`, establishment?.establishmentGrant
  ? { "x-alder-payment-grant": establishment.establishmentGrant }
  : {});
await ownerEnrollment.acknowledge();
if (establishment) await establishment.acknowledge();

const replacement = { ...state, hosted: { ...state.hosted, sessionId: session.id } };
// A session replacement starts without the mounted MCP/tool declaration.
// Configure it before durable state points Slack activation at the replacement;
// a failed configuration remains recoverable through the same creation key.
const standingPersonaHash = await configureStandingRuntime({
  alderMcpUrl,
  alderServicesUrl,
  control,
  state: replacement,
});

await writeState({
  ...replacement,
  standingPersonaHash,
  standingPersonaAppliedAt: new Date().toISOString(),
  pendingPersonaHash: undefined,
  previousSessionId: renewal.previousSessionId,
  renewedAt: new Date().toISOString(),
  ...(establishment ? { serviceConnectionEstablishedAt: new Date().toISOString() } : {}),
  sessionRenewal: undefined,
});

console.log(JSON.stringify({ event: "provibot.session_renewed", alderAgentId: state.alderAgentId, previousSessionId: renewal.previousSessionId, sessionId: session.id }));
