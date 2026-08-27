import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const receiverSources = [
  "bootstrap-deployer.mjs",
  "contract.mjs",
  "deploy.mjs",
  "deployer-role.mjs",
  "handler.mjs",
];

test("the Slack receiver imports only its local code, Node, and AWS SDK dependencies", async () => {
  for (const sourceName of receiverSources) {
    const source = await readFile(new URL(`../${sourceName}`, import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import(?:[\s\S]*?from\s+)?["']([^"']+)["'];?$/gm)];

    for (const [, specifier] of imports) {
      assert.match(specifier, /^(?:\.\/|node:|@aws-sdk\/)/, `${sourceName} must not import Alder application code`);
    }
  }
});
