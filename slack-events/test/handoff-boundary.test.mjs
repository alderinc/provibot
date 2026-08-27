import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the Slack worker retries only a failed Services handoff, never agent delivery", async () => {
  const source = await readFile(new URL("../handler.mjs", import.meta.url), "utf8");
  assert.match(source, /response\.status >= 500[\s\S]*throw new Error\(`activation handoff unavailable/);
  assert.match(source, /response\.status !== 202[\s\S]*provibot_slack_activation_handoff_rejected/);
  assert.match(source, /if \(await getItem\(eventKey\(candidate\.eventId\)\)\) return/);
  assert.match(source, /idempotency-key": `slack:\$\{candidate\.eventId\}`/);
  assert.doesNotMatch(source, /activationFailure|managedDeliveryAlert|deadLetterAlarm/);
});
