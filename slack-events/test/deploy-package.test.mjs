import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the shared receiver bundle includes every direct handler dependency", async () => {
  const deployer = await readFile(new URL("../deploy.mjs", import.meta.url), "utf8");
  assert.match(
    deployer,
    /\["-q", zipPath, "handler\.mjs", "contract\.mjs"\]/,
  );
});

test("deployment removes the retired client-side dead-letter policy with SQS's empty attribute value", async () => {
  const deployer = await readFile(new URL("../deploy.mjs", import.meta.url), "utf8");
  assert.match(
    deployer,
    /JSON\.stringify\(\{ RedrivePolicy: "" \}\)/,
  );
  assert.doesNotMatch(deployer, /RedrivePolicy: "\{\}"/);
});
