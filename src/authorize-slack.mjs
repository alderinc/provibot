import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { chmod, readFile, writeFile } from "node:fs/promises";

import { required } from "./shared.mjs";

const envPath = new URL("../.env", import.meta.url);
// This must match the redirect URI registered for the configured Slack app exactly.
// `localhost` also keeps the callback bound to the local machine.
const redirectUri = "http://localhost:8765/slack/oauth/callback";
const userScopes = [
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
const clientId = required("PROVIBOT_SLACK_CLIENT_ID");
const clientSecret = process.env.PROVIBOT_SLACK_CLIENT_SECRET?.trim() || null;
const expectedTeamId = required("PROVIBOT_SLACK_TEAM_ID");
const expectedUserId = required("PROVIBOT_SLACK_USER_ID");
const state = randomBytes(32).toString("base64url");
const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const authorization = new URL("https://slack.com/oauth/v2/authorize");
authorization.searchParams.set("client_id", clientId);
authorization.searchParams.set("redirect_uri", redirectUri);
authorization.searchParams.set("user_scope", userScopes.join(","));
authorization.searchParams.set("team", expectedTeamId);
authorization.searchParams.set("state", state);
authorization.searchParams.set("code_challenge", challenge);
authorization.searchParams.set("code_challenge_method", "S256");

function sameState(received) {
  const left = Buffer.from(String(received ?? ""));
  const right = Buffer.from(state);
  return left.length === right.length && timingSafeEqual(left, right);
}

function safeFailureMessage(error) {
  const message = error instanceof Error ? error.message : "unknown error";
  if (message === "Slack OAuth state mismatch") return "The callback did not match this authorization attempt. Start a fresh attempt from the terminal.";
  if (message.startsWith("Slack authorization failed")) return message;
  if (message.startsWith("Slack token exchange failed")) return message;
  if (message === "Slack token rotation is enabled; the standing launcher requires the existing non-rotating user credential") return message;
  if (message === "Slack authorization returned the wrong configured Slack identity") return message;
  if (message.startsWith("Slack authorization omitted")) return message;
  return "The callback could not be completed. See the local terminal for the safe diagnostic.";
}

async function replaceLocalEnv(values, remove = []) {
  const existing = await readFile(envPath, "utf8");
  const pending = new Map(Object.entries(values));
  const removed = new Set(remove);
  const written = new Set();
  const lines = existing.split(/\r?\n/).flatMap((line) => {
    const index = line.indexOf("=");
    if (index < 0) return [line];
    const name = line.slice(0, index);
    if (removed.has(name)) return [];
    if (!pending.has(name)) return [line];
    written.add(name);
    return [`${name}=${pending.get(name)}`];
  });
  for (const [name, value] of pending) if (!written.has(name)) lines.push(`${name}=${value}`);
  await writeFile(envPath, `${lines.join("\n").replace(/\n*$/, "")}\n`, { mode: 0o600 });
  await chmod(envPath, 0o600);
}

const completed = new Promise((resolve, reject) => {
  const server = createServer(async (request, response) => {
    const callback = new URL(request.url ?? "/", redirectUri);
    if (callback.pathname !== "/slack/oauth/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    let completedAuthorization = false;
    try {
      if (!sameState(callback.searchParams.get("state"))) throw new Error("Slack OAuth state mismatch");
      if (callback.searchParams.get("error")) throw new Error(`Slack authorization failed (${callback.searchParams.get("error")})`);
      const code = callback.searchParams.get("code");
      if (!code) throw new Error("Slack authorization callback omitted its code");
      const tokenResponse = await fetch("https://slack.com/api/oauth.v2.user.access", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        // This is the form-body exchange accepted by the existing Slack MCP
        // user-token authorization. PKCE-enabled public clients omit the
        // secret; confidential clients retain it only in ignored local .env.
        body: new URLSearchParams({
          client_id: clientId,
          ...(clientSecret ? { client_secret: clientSecret } : {}),
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        }),
      });
      const token = await tokenResponse.json().catch(() => null);
      const accessToken = token?.authed_user?.access_token ?? token?.access_token;
      if (!tokenResponse.ok || !token?.ok || typeof accessToken !== "string") throw new Error(`Slack token exchange failed (${token?.error ?? tokenResponse.status})`);
      if (token?.authed_user?.refresh_token || token?.refresh_token) throw new Error("Slack token rotation is enabled; the standing launcher requires the existing non-rotating user credential");
      const identityResponse = await fetch("https://slack.com/api/auth.test", { method: "POST", headers: { authorization: `Bearer ${accessToken}` } });
      const identity = await identityResponse.json().catch(() => null);
      const scopes = new Set((identityResponse.headers.get("x-oauth-scopes") ?? "").split(",").map((scope) => scope.trim()).filter(Boolean));
      if (!identityResponse.ok || !identity?.ok || identity.team_id !== expectedTeamId || identity.user_id !== expectedUserId) throw new Error("Slack authorization returned the wrong configured Slack identity");
      for (const scope of userScopes) if (!scopes.has(scope)) throw new Error(`Slack authorization omitted ${scope}`);
      // Keep the confidential-client secret in the ignored local .env. It is
      // required for future user-scope renewals, never leaves this OAuth
      // exchange, and never enters the hosted agent or Vault.
      await replaceLocalEnv({ PROVIBOT_SLACK_ACCESS_TOKEN: accessToken });
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ProVIBot Slack authorization stored locally. You may close this tab.");
      process.stdout.write(JSON.stringify({ stored: true, scopes: [...scopes].sort(), teamId: identity.team_id, userId: identity.user_id }) + "\n");
      completedAuthorization = true;
      resolve();
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end(`ProVIBot Slack authorization failed.\n\n${safeFailureMessage(error)}\n\nReturn to the terminal.`);
      // Do not let a stale tab, a prefetch, or a malformed callback consume the
      // one-time listener. The operator can retry the same live authorization
      // flow while the original state/verifier stay in memory.
      process.stderr.write(`Slack authorization callback rejected: ${error instanceof Error ? error.message : "unknown error"}\n`);
      return;
    }
    if (completedAuthorization) server.close();
  });
  server.listen(8765, "localhost", () => process.stdout.write(`Open this one-time authorization URL:\n${authorization}\n`));
  server.on("error", reject);
  const timer = setTimeout(() => { server.close(); reject(new Error("Slack authorization timed out")); }, 30 * 60 * 1000);
  server.on("close", () => clearTimeout(timer));
});

await completed;
