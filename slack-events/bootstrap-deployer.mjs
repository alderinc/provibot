import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployerPolicy, deployerRoleArn, deployerRoleName, deployerTrust } from "./deployer-role.mjs";

const execFile = promisify(execFileCallback);
const region = process.env.AWS_REGION?.trim() || "eu-central-1";

async function aws(args) {
  const { stdout } = await execFile("aws", [...args, "--region", region], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function awsJson(args) {
  const output = await aws([...args, "--output", "json"]);
  return output ? JSON.parse(output) : null;
}

async function temporaryJson(directory, value) {
  const path = join(directory, "policy.json");
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

const caller = await awsJson(["sts", "get-caller-identity"]);
const account = caller?.Account;
if (!account) throw new Error("an authenticated AWS CLI identity is required");
const directory = await mkdtemp(join(tmpdir(), "provibot-deployer-bootstrap-"));
try {
  const trustPath = await temporaryJson(directory, deployerTrust(account));
  try {
    await aws(["iam", "create-role", "--role-name", deployerRoleName, "--assume-role-policy-document", `file://${trustPath}`]);
  } catch (error) {
    if (!String(error.stderr ?? error).includes("EntityAlreadyExists")) throw error;
    await aws(["iam", "update-assume-role-policy", "--role-name", deployerRoleName, "--policy-document", `file://${trustPath}`]);
  }
  const policyPath = await temporaryJson(directory, deployerPolicy({ account, region }));
  await aws(["iam", "put-role-policy", "--role-name", deployerRoleName, "--policy-name", `${deployerRoleName}-policy`, "--policy-document", `file://${policyPath}`]);
  console.log(JSON.stringify({
    event: "provibot.slack_events.deployer_bootstrapped",
    roleArn: deployerRoleArn(account),
    sourceAccount: account,
  }));
} finally {
  await rm(directory, { force: true, recursive: true });
}
