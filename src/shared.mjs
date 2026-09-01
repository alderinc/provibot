import { createDecipheriv, createHash } from "node:crypto";

import { alderServicesUrl, alderUrl } from "./endpoints.mjs";

export function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function decryptEnrollment(secret, installationId, encrypted) {
  const key = createHash("sha256")
    .update("alder-runtime-enrollment-v1\0")
    .update(secret)
    .update("\0")
    .update(installationId)
    .digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64url"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8"));
}

export async function requestJson(url, init, label) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const candidateType = payload?.error?.code ?? payload?.error?.type ?? payload?.code ?? payload?.type;
    const upstreamType = typeof candidateType === "string" && /^[a-zA-Z0-9_./:-]{1,160}$/.test(candidateType)
      ? ` (${candidateType})`
      : "";
    const reference = typeof payload?.error?.reference === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(payload.error.reference)
      ? ` [reference ${payload.error.reference}]`
      : "";
    const requestId = response.headers.get("request-id") ?? response.headers.get("x-alder-services-request-id");
    const requestReference = requestId && /^[a-zA-Z0-9_-]{1,160}$/.test(requestId) ? ` [request ${requestId}]` : "";
    throw new Error(`${label} returned HTTP ${response.status}${upstreamType}${reference}${requestReference}`);
  }
  return payload;
}

export function legacyManagedControlHeaders(accessToken, idempotencyKey) {
  const basic = Buffer.from(`${required("ALDER_SERVICES_LEGACY_CONTROL_BASIC_AUTH_USERNAME")}:${required("ALDER_SERVICES_LEGACY_CONTROL_BASIC_AUTH_PASSWORD")}`).toString("base64");
  return {
    accept: "application/json",
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "x-alder-preview-authorization": `Basic ${basic}`,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

export function previewAuthHeader(usernameName, passwordName) {
  const basic = Buffer.from(`${required(usernameName)}:${required(passwordName)}`).toString("base64");
  return { "x-alder-preview-authorization": `Basic ${basic}` };
}

export async function refreshCredentials(credentials) {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
    resource: credentials.resource,
    scope: credentials.scopes.join(" "),
  });
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
  const refreshed = await requestJson(`${alderUrl}/oauth/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      ...previewAuthHeader("ALDER_BASIC_AUTH_USERNAME", "ALDER_BASIC_AUTH_PASSWORD"),
    },
    body,
  }, "refresh Alder control credential");
  return {
    ...credentials,
    accessToken: refreshed.access_token,
    accessTokenExpiresAt: new Date(Date.now() + Number(refreshed.expires_in) * 1_000).toISOString(),
    refreshToken: refreshed.refresh_token ?? credentials.refreshToken,
  };
}

export async function managed(method, path, accessToken, body, idempotencyKey) {
  return requestJson(`${alderServicesUrl}/agent-instances${path}`, {
    method,
    // The temporary Basic fallback is limited to this retiring control family.
    // Provider, connection, discovery, and MCP requests never receive it.
    headers: legacyManagedControlHeaders(accessToken, idempotencyKey),
    body: body === undefined ? undefined : JSON.stringify(body),
  }, `${method} ${path}`);
}
