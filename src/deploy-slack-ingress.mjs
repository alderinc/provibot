import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { recoverIngressServicesAccess } from "./service-payment-enrollment.mjs";
import { refreshCredentials } from "./shared.mjs";

const execFile = promisify(execFileCallback);
const statePath = new URL("../.local-state/provibot.json", import.meta.url);
const authPath = new URL("../.local-state/provibot-auth.json", import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writePrivate(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function freshControlCredentials() {
  const credentials = await readJson(authPath);
  if (!credentials?.accessToken || !credentials?.refreshToken || !credentials?.clientId || !credentials?.clientSecret) {
    throw new Error("the local ProVIBot owner control credential is unavailable; run npm start before deploying Slack ingress");
  }
  if (Date.parse(credentials.accessTokenExpiresAt) > Date.now() + 90_000) return credentials;
  const refreshed = await refreshCredentials(credentials);
  await writePrivate(authPath, refreshed);
  return refreshed;
}

const state = await readJson(statePath);
if (!state?.alderAgentId) throw new Error("the existing ProVIBot identity is unavailable");
const ingress = await recoverIngressServicesAccess(await freshControlCredentials());
if (!ingress?.sat) throw new Error("the ProVIBot Services connection is not established; run npm start before deploying Slack ingress");

const directory = await mkdtemp(join(tmpdir(), "provibot-ingress-sat-"));
const tokenPath = join(directory, "sat");
try {
  await writeFile(tokenPath, ingress.sat, { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  const deployed = await execFile(process.execPath, [new URL("../slack-events/deploy.mjs", import.meta.url).pathname], {
    env: { ...process.env, PROVIBOT_INGRESS_SAT_FILE: tokenPath },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (deployed.stdout) process.stdout.write(deployed.stdout);
  if (deployed.stderr) process.stderr.write(deployed.stderr);
  console.log(JSON.stringify({ event: "provibot.slack_ingress_recovered", mode: "ingress", pmaConnectionReused: true }));
} finally {
  await rm(directory, { force: true, recursive: true });
}
