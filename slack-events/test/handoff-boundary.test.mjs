import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the Slack worker resolves the active session at delivery and retries only unavailable Services ingress", async () => {
  const source = await readFile(new URL("../handler.mjs", import.meta.url), "utf8");
  assert.match(source, /\/agent-instances\/active-session/);
  assert.match(source, /\/agent-instances\/sessions\/\$\{encodeURIComponent\(session\.sessionId\)\}\/events/);
  assert.match(source, /authorization: `Bearer \$\{config\.ingressSat\}`/);
  assert.match(source, /sessionResponse\.status >= 500[\s\S]*ingress session lookup unavailable/);
  assert.match(source, /response\.status >= 500[\s\S]*ingress delivery unavailable/);
  assert.match(source, /no_active_session/);
  assert.match(source, /services_access_rejected/);
  assert.match(source, /response\.status !== 202[\s\S]*provibot_slack_ingress_delivery_rejected/);
  assert.match(source, /if \(await getItem\(eventKey\(candidate\.eventId\)\)\) return/);
  assert.match(source, /idempotency-key": `slack:\$\{candidate\.eventId\}`/);
  for (const forbidden of ["activationClientId", "activationClientSecret", "activationAccessToken", "/oauth/authorize", "/oauth/token", "managed-sessions:events:write"]) {
    assert.doesNotMatch(source, new RegExp(forbidden.replaceAll("/", "\\/")));
  }
  assert.doesNotMatch(source, /activationFailure|managedDeliveryAlert|deadLetterAlarm/);
});
