import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { createHash, randomBytes } from "node:crypto";

import { candidateFromSlackEnvelope, eventKey, neutralUserMessage, verifySlackSignature } from "./contract.mjs";

const ddb = new DynamoDBClient({});
const kms = new KMSClient({});
const secrets = new SecretsManagerClient({});
const sqs = new SQSClient({});
const THREAD_TTL_SECONDS = 7 * 24 * 60 * 60;
let secretCache = null;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function response(statusCode, body = "") {
  return { statusCode, body, headers: { "content-type": "text/plain; charset=utf-8" } };
}

function rawBody(event) {
  return event?.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event?.body ?? "";
}

function header(event, name) {
  const expected = name.toLowerCase();
  return Object.entries(event?.headers ?? {}).find(([key]) => key.toLowerCase() === expected)?.[1] ?? "";
}

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function configuration() {
  // Lambda warm invocations reuse this parsed configuration in memory. Secrets
  // Manager remains the persistence boundary; its contents are never logged or
  // written to DynamoDB.
  if (secretCache) return secretCache;
  const value = await secrets.send(new GetSecretValueCommand({ SecretId: required("CONFIG_SECRET_ARN") }));
  if (!value.SecretString) throw new Error("activation configuration is unavailable");
  const config = JSON.parse(value.SecretString);
  for (const name of [
    "activationClientId", "activationClientSecret", "activationRedirectUri", "agentId", "alderOrigin",
    "alderPreviewBasicPassword", "alderPreviewBasicUsername", "generalChannelId", "servicesOrigin",
    "servicesPreviewBasicPassword", "servicesPreviewBasicUsername", "serviceUserId", "slackSigningSecret", "teamId",
  ]) if (typeof config[name] !== "string" || !config[name]) throw new Error(`activation configuration ${name} is invalid`);
  secretCache = config;
  return config;
}

async function getItem(pk) {
  const result = await ddb.send(new GetItemCommand({ Key: { pk: { S: pk } }, TableName: required("STATE_TABLE") }));
  return result.Item ?? null;
}

async function putItem(Item) {
  await ddb.send(new PutItemCommand({ Item, TableName: required("STATE_TABLE") }));
}

function tokenContext(config) {
  return { agent: config.agentId, purpose: "alder-provibot-slack-activation-refresh-v1" };
}

async function readTokens(config) {
  const item = await getItem("activation");
  if (!item?.ciphertext?.B) return null;
  const decrypted = await kms.send(new DecryptCommand({
    CiphertextBlob: item.ciphertext.B,
    EncryptionContext: tokenContext(config),
    KeyId: required("TOKEN_KMS_KEY_ARN"),
  }));
  if (!decrypted.Plaintext) throw new Error("activation token state cannot be decrypted");
  return JSON.parse(Buffer.from(decrypted.Plaintext).toString("utf8"));
}

async function writeTokens(config, tokens) {
  const encrypted = await kms.send(new EncryptCommand({
    EncryptionContext: tokenContext(config),
    KeyId: required("TOKEN_KMS_KEY_ARN"),
    Plaintext: Buffer.from(JSON.stringify(tokens), "utf8"),
  }));
  if (!encrypted.CiphertextBlob) throw new Error("activation token state cannot be encrypted");
  await putItem({ ciphertext: { B: encrypted.CiphertextBlob }, pk: { S: "activation" }, updatedAt: { S: new Date().toISOString() } });
}

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { challenge: createHash("sha256").update(verifier).digest("base64url"), verifier };
}

async function exchange(config, body) {
  const response = await fetch(`${config.alderOrigin}/oauth/token`, {
    body: new URLSearchParams(body),
    headers: {
      authorization: basic(config.activationClientId, config.activationClientSecret),
      "content-type": "application/x-www-form-urlencoded",
      "x-alder-preview-authorization": basic(config.alderPreviewBasicUsername, config.alderPreviewBasicPassword),
    },
    method: "POST",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || typeof payload?.access_token !== "string" || typeof payload?.refresh_token !== "string") throw new Error(`activation token exchange failed (${response.status})`);
  return { accessToken: payload.access_token, expiresAt: new Date(Date.now() + Number(payload.expires_in) * 1000).toISOString(), refreshToken: payload.refresh_token };
}

async function initialTokens(config) {
  const { challenge, verifier } = pkce();
  const authorization = new URL(`${config.alderOrigin}/oauth/authorize`);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", config.activationClientId);
  authorization.searchParams.set("redirect_uri", config.activationRedirectUri);
  authorization.searchParams.set("resource", config.servicesOrigin);
  authorization.searchParams.set("scope", "managed-sessions:events:write");
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  const response = await fetch(authorization, {
    headers: { "x-alder-preview-authorization": basic(config.alderPreviewBasicUsername, config.alderPreviewBasicPassword) },
    redirect: "manual",
  });
  const location = response.headers.get("location");
  if (response.status !== 302 || !location) throw new Error(`activation authorization failed (${response.status})`);
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error("activation authorization did not return a code");
  return exchange(config, { code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: config.activationRedirectUri, resource: config.servicesOrigin });
}

async function activationAccessToken(config) {
  // The worker is serialized for this agent, which prevents concurrent refresh
  // rotation. Stored tokens are encrypted and bound to the agent context below.
  let tokens = await readTokens(config);
  if (!tokens) {
    tokens = await initialTokens(config);
    await writeTokens(config, tokens);
    return tokens.accessToken;
  }
  if (Date.parse(tokens.expiresAt) > Date.now() + 90_000) return tokens.accessToken;
  tokens = await exchange(config, { grant_type: "refresh_token", refresh_token: tokens.refreshToken, resource: config.servicesOrigin });
  await writeTokens(config, tokens);
  return tokens.accessToken;
}

async function threadIsActive(candidate) {
  if (!candidate.requiresActiveThread) return true;
  const item = await getItem(candidate.threadKey);
  return Boolean(item?.expiresAt?.N && Number(item.expiresAt.N) > Math.floor(Date.now() / 1000));
}

async function deliver(candidate, config) {
  // DynamoDB suppresses completed deliveries; the Services idempotency key
  // covers the narrow crash window after delivery succeeds but before this
  // worker records completion.
  if (await getItem(eventKey(candidate.eventId))) return;
  if (!(await threadIsActive(candidate))) return;
  const response = await fetch(`${config.servicesOrigin}/agent-instances/activation/events`, {
    body: JSON.stringify(neutralUserMessage(candidate)),
    headers: {
      authorization: `Bearer ${await activationAccessToken(config)}`,
      "content-type": "application/json",
      "idempotency-key": `slack:${candidate.eventId}`,
      "x-alder-preview-authorization": basic(config.servicesPreviewBasicUsername, config.servicesPreviewBasicPassword),
    },
    method: "POST",
  });
  // A reachable Services boundary has made an authoritative decision. Normal
  // work returns 202 and is durably queued there; an honest terminal rejection
  // is logged without replaying a malformed/unauthorized Slack instruction.
  // The FIFO queue retries only a handoff that did not reach that boundary:
  // transport exceptions and an unavailable (5xx) Services edge. It never
  // retries supplier delivery, session rearm, or a customer-funding state.
  if (response.status >= 500) {
    throw new Error(`activation handoff unavailable (${response.status})`);
  }
  if (response.status !== 202) {
    console.error("provibot_slack_activation_handoff_rejected", {
      eventId: candidate.eventId,
      status: response.status,
    });
  }
  const expiresAt = Math.floor(Date.now() / 1000) + THREAD_TTL_SECONDS;
  await putItem({ expiresAt: { N: String(expiresAt) }, pk: { S: eventKey(candidate.eventId) } });
  if (candidate.threadKey) await putItem({ expiresAt: { N: String(expiresAt) }, pk: { S: candidate.threadKey } });
}

export async function ingress(event) {
  if (event?.requestContext?.http?.method !== "POST") return response(405);
  const body = rawBody(event);
  const config = await configuration();
  if (!verifySlackSignature({
    body,
    secret: config.slackSigningSecret,
    signature: header(event, "x-slack-signature"),
    timestamp: header(event, "x-slack-request-timestamp"),
  })) return response(401);
  let envelope;
  try { envelope = JSON.parse(body); } catch { return response(400); }
  if (envelope?.type === "url_verification" && typeof envelope.challenge === "string") return response(200, envelope.challenge);
  const candidate = candidateFromSlackEnvelope(envelope, config);
  if (!candidate) return response(200, "ok");
  // The single message group preserves the activation order for one agent.
  // It intentionally carries only normalized routing data, never a Slack API
  // credential or a copied file body.
  await sqs.send(new SendMessageCommand({
    MessageBody: JSON.stringify(candidate),
    MessageDeduplicationId: createHash("sha256").update(candidate.eventId).digest("hex"),
    MessageGroupId: config.agentId,
    QueueUrl: required("QUEUE_URL"),
  }));
  return response(200, "ok");
}

export async function worker(event) {
  const failures = [];
  const config = await configuration();
  for (const record of event.Records ?? []) {
    try {
      await deliver(JSON.parse(record.body), config);
    } catch (error) {
      let eventId = "unknown";
      try { eventId = JSON.parse(record.body).eventId; } catch { /* preserve opaque logs */ }
      console.error("provibot_slack_activation_delivery_failed", {
        eventId,
        failureClass: "handoff_transport",
      });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
