import { createHash, createHmac, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployerRoleArn, deployerRoleName, prefix } from "./deployer-role.mjs";

// The receiver has the same fixed public endpoints as the application, but it
// is intentionally packaged without importing application code.
const alderUrl = "https://app.alder.exchange";
const alderServicesUrl = "https://services.alder.exchange";
const execFile = promisify(execFileCallback);
const region = process.env.AWS_REGION?.trim() || "eu-central-1";
const names = {
  ingress: `${prefix}-ingress`,
  ingressRole: `${prefix}-ingress-role`,
  queue: `${prefix}.fifo`,
  state: `${prefix}-state`,
  worker: `${prefix}-worker`,
  workerRole: `${prefix}-worker-role`,
};
const inheritedAwsCredentialNames = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];
// The caller's named profile establishes who may assume the narrow deployer
// role. Refusing ambient key variables avoids accidentally copying deployment
// authority into the repository's local application configuration.
for (const name of inheritedAwsCredentialNames) {
  if (process.env[name]?.trim()) throw new Error(`${name} must not be supplied through .env; authenticate the local AWS CLI with a named profile instead`);
}
let deploymentEnvironment = null;
const activationPath = new URL("../.local-state/provibot-activation-client.json", import.meta.url);
const bootstrapPath = new URL("../.local-state/provibot-activation-bootstrap.json", import.meta.url);
const hostedPath = new URL("../.local-state/provibot.json", import.meta.url);
const statePath = new URL("../.local-state/provibot-slack-events.json", import.meta.url);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function aws(args) {
  const { stdout } = await execFile("aws", [...args, "--region", region], { env: deploymentEnvironment ?? process.env, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function awsJson(args) {
  const output = await aws([...args, "--output", "json"]);
  return output ? JSON.parse(output) : null;
}

async function exists(args) {
  try { await aws(args); return true; } catch { return false; }
}

async function writePrivate(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function temporaryJson(directory, value) {
  const path = join(directory, `${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function pkce() {
  const verifier = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  return { challenge: createHash("sha256").update(verifier).digest("base64url"), verifier };
}

async function ensureRole(name, trustPath) {
  if (!(await exists(["iam", "get-role", "--role-name", name]))) {
    await aws(["iam", "create-role", "--role-name", name, "--assume-role-policy-document", `file://${trustPath}`]);
  }
  await aws(["iam", "wait", "role-exists", "--role-name", name]);
  return (await awsJson(["iam", "get-role", "--role-name", name])).Role.Arn;
}

async function queueUrl(name, attributes) {
  if (!(await exists(["sqs", "get-queue-url", "--queue-name", name]))) {
    await aws(["sqs", "create-queue", "--queue-name", name, "--attributes", JSON.stringify(attributes)]);
  }
  return aws(["sqs", "get-queue-url", "--queue-name", name, "--query", "QueueUrl", "--output", "text"]);
}

async function deployFunction({ environment, name, roleArn, timeout, zipPath }) {
  const handler = name === names.ingress ? "handler.ingress" : "handler.worker";
  if (await exists(["lambda", "get-function", "--function-name", name])) {
    await aws(["lambda", "update-function-code", "--function-name", name, "--zip-file", `fileb://${zipPath}`]);
    await aws(["lambda", "wait", "function-updated-v2", "--function-name", name]);
    await aws(["lambda", "update-function-configuration", "--function-name", name, "--runtime", "nodejs22.x", "--handler", handler, "--timeout", String(timeout), "--environment", JSON.stringify({ Variables: environment })]);
  } else {
    await aws(["lambda", "create-function", "--function-name", name, "--runtime", "nodejs22.x", "--architectures", "arm64", "--role", roleArn, "--handler", handler, "--timeout", String(timeout), "--zip-file", `fileb://${zipPath}`, "--environment", JSON.stringify({ Variables: environment })]);
  }
  await aws(["lambda", "wait", "function-active-v2", "--function-name", name]);
}

async function addPermission(args) {
  try { await aws(args); } catch (error) { if (!String(error.stderr ?? error).includes("ResourceConflictException")) throw error; }
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value, "utf8").digest(encoding);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function cliCredentials() {
  const { stdout } = await execFile("aws", ["configure", "export-credentials", "--format", "process"], { env: deploymentEnvironment ?? process.env, maxBuffer: 8 * 1024 * 1024 });
  const credentials = JSON.parse(stdout);
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey) throw new Error("AWS CLI did not export deploy credentials");
  return credentials;
}

async function addInvokeViaFunctionUrlPermission() {
  // AWS CLI 2.12, present on the current operator machine, predates the
  // --invoked-via-function-url option. Use Lambda's documented REST operation
  // with SigV4 only for that missing condition; all other calls stay on the CLI.
  const credentials = await cliCredentials();
  const host = `lambda.${region}.amazonaws.com`;
  const canonicalUri = `/2015-03-31/functions/${encodeURIComponent(names.ingress)}/policy`;
  const payload = JSON.stringify({
    Action: "lambda:InvokeFunction",
    InvokedViaFunctionUrl: true,
    Principal: "*",
    StatementId: "AllowSlackEventsInvokeViaUrl",
  });
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const headers = {
    "content-type": "application/x-amz-json-1.0",
    host,
    "x-amz-date": amzDate,
    ...(credentials.SessionToken ? { "x-amz-security-token": credentials.SessionToken } : {}),
  };
  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaders.map((name) => `${name}:${headers[name]}\n`).join("");
  const credentialScope = `${date}/${region}/lambda/aws4_request`;
  const canonicalRequest = ["POST", canonicalUri, "", canonicalHeaders, signedHeaders.join(";"), sha256(payload)].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.SecretAccessKey}`, date), region), "lambda"), "aws4_request");
  const signature = hmac(signingKey, stringToSign, "hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${credentials.AccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`;
  const response = await fetch(`https://${host}${canonicalUri}`, { body: payload, headers: { ...headers, authorization }, method: "POST" });
  if (response.status === 409) return;
  if (!response.ok) throw new Error(`Lambda rejected function-URL-only invocation permission (${response.status})`);
}

async function sourceAwsJson(args) {
  const { stdout } = await execFile("aws", [...args, "--region", region, "--output", "json"], { env: process.env, maxBuffer: 8 * 1024 * 1024 });
  return stdout ? JSON.parse(stdout) : null;
}

function assumedRoleEnvironment(credentials) {
  const environment = { ...process.env };
  delete environment.AWS_PROFILE;
  delete environment.AWS_DEFAULT_PROFILE;
  Object.assign(environment, {
    AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: credentials.SessionToken,
  });
  return environment;
}

const sourceCaller = await sourceAwsJson(["sts", "get-caller-identity"]);
if (!sourceCaller?.Account) throw new Error("an authenticated AWS CLI profile is required before deployment");
const deploymentRoleArn = deployerRoleArn(sourceCaller.Account);
const alreadyAssumed = String(sourceCaller.Arn ?? "").includes(`:assumed-role/${deployerRoleName}/`);
const sourceIsRoot = String(sourceCaller.Arn ?? "").endsWith(":root");
if (sourceIsRoot) {
  if (process.env.PROVIBOT_ALLOW_ROOT_BOOTSTRAP !== "1") {
    throw new Error(`the AWS root principal cannot assume ${deploymentRoleArn}; use a non-root AWS profile or explicitly set PROVIBOT_ALLOW_ROOT_BOOTSTRAP=1 only for this account bootstrap deployment`);
  }
  deploymentEnvironment = process.env;
} else if (alreadyAssumed) {
  deploymentEnvironment = process.env;
} else {
  // The deployer role is the standing path. Root is an explicit one-time
  // bootstrap escape hatch only because root cannot assume roles.
  let assumed;
  try {
    assumed = await sourceAwsJson(["sts", "assume-role", "--role-arn", deploymentRoleArn, "--role-session-name", `provibot-deploy-${Date.now()}`]);
  } catch (error) {
    throw new Error(`cannot assume ${deploymentRoleArn}; an account administrator must first run npm run bootstrap:slack-events-deployer and your local AWS profile needs sts:AssumeRole for that role`);
  }
  if (!assumed?.Credentials?.AccessKeyId || !assumed.Credentials.SecretAccessKey || !assumed.Credentials.SessionToken) throw new Error("AWS did not return deployer role credentials");
  deploymentEnvironment = assumedRoleEnvironment(assumed.Credentials);
}

const [activation, bootstrap, hosted, caller] = await Promise.all([json(activationPath), json(bootstrapPath), json(hostedPath), awsJson(["sts", "get-caller-identity"])]);
if (!activation?.clientId || !bootstrap?.clientSecret || activation.clientId !== bootstrap.clientId || !hosted?.alderAgentId) {
  throw new Error("the existing ProVIBot activation client bootstrap is unavailable");
}
const config = {
  activationClientId: activation.clientId,
  activationClientSecret: bootstrap.clientSecret,
  activationRedirectUri: activation.redirectUri,
  agentId: hosted.alderAgentId,
  alderOrigin: alderUrl,
  alderPreviewBasicPassword: required("ALDER_BASIC_AUTH_PASSWORD"),
  alderPreviewBasicUsername: required("ALDER_BASIC_AUTH_USERNAME"),
  generalChannelId: required("PROVIBOT_SLACK_CHANNEL_ID"),
  schema: "alder.provibot.slack-events/v1",
  servicesOrigin: alderServicesUrl,
  servicesPreviewBasicPassword: required("ALDER_SERVICES_BASIC_AUTH_PASSWORD"),
  servicesPreviewBasicUsername: required("ALDER_SERVICES_BASIC_AUTH_USERNAME"),
  serviceUserId: required("PROVIBOT_SLACK_USER_ID"),
  slackSigningSecret: required("PROVIBOT_SLACK_SIGNING_SECRET"),
  teamId: required("PROVIBOT_SLACK_TEAM_ID"),
};

const directory = await mkdtemp(join(tmpdir(), "provibot-slack-events-"));
try {
  // Provision the receiver in place. Resource names are stable so this command
  // updates the standing ingress instead of creating a second event path.
  const trustPath = await temporaryJson(directory, { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] });
  const queue = await queueUrl(names.queue, { ContentBasedDeduplication: "false", FifoQueue: "true", SqsManagedSseEnabled: "true", VisibilityTimeout: "30" });
  // Network delivery is the queue's only retry responsibility. A reachable
  // Services boundary owns durable instruction recovery, so clear the retired
  // client-side dead-letter routing on existing deployments as well.
  // SQS removes an optional string-valued attribute when it is set to the
  // empty value. An empty JSON object is invalid here: any present
  // RedrivePolicy must name both a dead-letter queue and maxReceiveCount.
  await aws(["sqs", "set-queue-attributes", "--queue-url", queue, "--attributes", JSON.stringify({ RedrivePolicy: "" })]);
  const queueArn = await aws(["sqs", "get-queue-attributes", "--queue-url", queue, "--attribute-names", "QueueArn", "--query", "Attributes.QueueArn", "--output", "text"]);
  const secretName = "alder/pay/provibot/slack-events-receiver";
  let secretArn;
  const configPath = await temporaryJson(directory, config);
  if (await exists(["secretsmanager", "describe-secret", "--secret-id", secretName])) {
    secretArn = await aws(["secretsmanager", "describe-secret", "--secret-id", secretName, "--query", "ARN", "--output", "text"]);
    await aws(["secretsmanager", "put-secret-value", "--secret-id", secretArn, "--secret-string", `file://${configPath}`]);
  } else {
    secretArn = await aws(["secretsmanager", "create-secret", "--name", secretName, "--secret-string", `file://${configPath}`, "--query", "ARN", "--output", "text"]);
  }
  if (!(await exists(["dynamodb", "describe-table", "--table-name", names.state]))) {
    await aws(["dynamodb", "create-table", "--table-name", names.state, "--attribute-definitions", "AttributeName=pk,AttributeType=S", "--key-schema", "AttributeName=pk,KeyType=HASH", "--billing-mode", "PAY_PER_REQUEST"]);
    await aws(["dynamodb", "wait", "table-exists", "--table-name", names.state]);
    await aws(["dynamodb", "update-time-to-live", "--table-name", names.state, "--time-to-live-specification", "Enabled=true,AttributeName=expiresAt"]);
  }
  const kmsAlias = `alias/${names.state}`;
  let kmsKeyArn;
  if (await exists(["kms", "describe-key", "--key-id", kmsAlias])) {
    kmsKeyArn = await aws(["kms", "describe-key", "--key-id", kmsAlias, "--query", "KeyMetadata.Arn", "--output", "text"]);
  } else {
    const keyId = await aws(["kms", "create-key", "--description", "ProVIBot Slack activation refresh state", "--query", "KeyMetadata.KeyId", "--output", "text"]);
    await aws(["kms", "create-alias", "--alias-name", kmsAlias, "--target-key-id", keyId]);
    kmsKeyArn = await aws(["kms", "describe-key", "--key-id", kmsAlias, "--query", "KeyMetadata.Arn", "--output", "text"]);
  }
  const ingressRoleArn = await ensureRole(names.ingressRole, trustPath);
  const workerRoleArn = await ensureRole(names.workerRole, trustPath);
  for (const [role, managed] of [[names.ingressRole, "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"], [names.workerRole, "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"], [names.workerRole, "arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole"]]) await aws(["iam", "attach-role-policy", "--role-name", role, "--policy-arn", managed]);
  const ingressPolicy = await temporaryJson(directory, { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: secretArn }, { Effect: "Allow", Action: ["sqs:SendMessage"], Resource: queueArn }] });
  const workerPolicy = await temporaryJson(directory, { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: secretArn }, { Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:PutItem"], Resource: `arn:aws:dynamodb:${region}:${caller.Account}:table/${names.state}` }, { Effect: "Allow", Action: ["kms:Decrypt", "kms:Encrypt"], Resource: kmsKeyArn }] });
  await aws(["iam", "put-role-policy", "--role-name", names.ingressRole, "--policy-name", `${prefix}-ingress`, "--policy-document", `file://${ingressPolicy}`]);
  await aws(["iam", "put-role-policy", "--role-name", names.workerRole, "--policy-name", `${prefix}-worker`, "--policy-document", `file://${workerPolicy}`]);
  const zipPath = join(directory, "receiver.zip");
  // Both ingress and worker load the same handler module. Keep every direct
  // local ESM dependency in the shared ZIP so either Lambda can initialize.
  await execFile("zip", ["-q", zipPath, "handler.mjs", "contract.mjs"], { cwd: new URL(".", import.meta.url).pathname });
  await deployFunction({ name: names.ingress, roleArn: ingressRoleArn, zipPath, timeout: 10, environment: { CONFIG_SECRET_ARN: secretArn, QUEUE_URL: queue } });
  await deployFunction({ name: names.worker, roleArn: workerRoleArn, zipPath, timeout: 20, environment: { CONFIG_SECRET_ARN: secretArn, STATE_TABLE: names.state, TOKEN_KMS_KEY_ARN: kmsKeyArn } });
  await aws(["lambda", "put-function-concurrency", "--function-name", names.worker, "--reserved-concurrent-executions", "1"]);
  let functionUrl;
  try { functionUrl = await aws(["lambda", "get-function-url-config", "--function-name", names.ingress, "--query", "FunctionUrl", "--output", "text"]); }
  catch { functionUrl = await aws(["lambda", "create-function-url-config", "--function-name", names.ingress, "--auth-type", "NONE", "--query", "FunctionUrl", "--output", "text"]); }
  await addPermission(["lambda", "add-permission", "--function-name", names.ingress, "--statement-id", "AllowSlackEventsFunctionUrl", "--action", "lambda:InvokeFunctionUrl", "--principal", "*", "--function-url-auth-type", "NONE"]);
  await addInvokeViaFunctionUrlPermission();
  const mappings = await awsJson(["lambda", "list-event-source-mappings", "--function-name", names.worker]);
  // Reserved function concurrency plus the single FIFO message group serialize
  // one agent's refresh family. SQS mapping concurrency itself has a minimum of two.
  if (!mappings.EventSourceMappings?.some((item) => item.EventSourceArn === queueArn)) await aws(["lambda", "create-event-source-mapping", "--event-source-arn", queueArn, "--function-name", names.worker, "--batch-size", "1", "--function-response-types", "ReportBatchItemFailures"]);
  await writePrivate(statePath, { deployedAt: new Date().toISOString(), functionUrl, kmsKeyArn, queueArn, secretArn, stateTable: names.state });
  console.log(JSON.stringify({ event: "provibot.slack_events.deployed", requestUrl: `${functionUrl}slack/events` }));
} finally {
  await rm(directory, { force: true, recursive: true });
}
