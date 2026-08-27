import { readFile, rm, writeFile } from "node:fs/promises";

import { managed, refreshCredentials } from "./shared.mjs";

const stateUrl = new URL("../.local-state/provibot.json", import.meta.url);
const authUrl = new URL("../.local-state/provibot-auth.json", import.meta.url);
const listenerUrl = new URL("../.local-state/provibot-listener.json", import.meta.url);
const state = JSON.parse(await readFile(stateUrl, "utf8"));
let credentials = JSON.parse(await readFile(authUrl, "utf8"));
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

// Services snapshots authoritative supplier usage and settles the active
// segment before it deletes a session. Failure leaves all resources intact.
await control("DELETE", `/sessions/${encodeURIComponent(state.hosted.sessionId)}`, undefined, `provibot:${state.runId}:stop-session`);
for (const [collection, id, method, suffix = ""] of [
  ["agents", state.hosted.agentId, "POST", "/archive"],
  ["environments", state.hosted.environmentId, "DELETE"],
  ["vaults", state.hosted.vaultId, "DELETE"],
  ["memory_stores", state.hosted.memoryStoreId, "DELETE"],
]) {
  if (id) await control(method, `/${collection}/${encodeURIComponent(id)}${suffix}`, method === "POST" ? {} : undefined, `provibot:${state.runId}:stop:${collection}:${id}`);
}
await rm(stateUrl);
await rm(authUrl);
await rm(listenerUrl, { force: true });
console.log("ProVIBot hosted resources settled and removed; the Alder identity remains preserved.");
