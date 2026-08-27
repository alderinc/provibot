import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { candidateFromSlackEnvelope, neutralUserMessage, verifySlackSignature } from "../contract.mjs";

const config = { generalChannelId: "C_GENERAL", serviceUserId: "U_PROVIBOT", teamId: "T_WORKSPACE" };
const base = { event_id: "Ev0123456789", team_id: "T_WORKSPACE", type: "event_callback" };

test("verifies Slack HMAC and rejects expired or altered requests", () => {
  const now = 1_700_000_000_000;
  const body = '{"type":"url_verification"}';
  const timestamp = String(now / 1000);
  const signature = `v0=${createHmac("sha256", "secret").update(`v0:${timestamp}:${body}`).digest("hex")}`;
  assert.equal(verifySlackSignature({ body, now, secret: "secret", signature, timestamp }), true);
  assert.equal(verifySlackSignature({ body: `${body} `, now, secret: "secret", signature, timestamp }), false);
  assert.equal(verifySlackSignature({ body, now: now + 301_000, secret: "secret", signature, timestamp }), false);
});

test("accepts a direct message and preserves the request verbatim", () => {
  const candidate = candidateFromSlackEnvelope({ ...base, event: { channel: "D_1", channel_type: "im", event_ts: "1.2", text: "Please inspect this", ts: "1.2", type: "message", user: "U_ARMIN" } }, config);
  assert.ok(candidate);
  assert.equal(candidate.conversationType, "dm");
  assert.equal(candidate.requiresActiveThread, false);
  assert.equal(candidate.attention, "direct");
  assert.equal(candidate.replyDefault, "top_level");
  const text = neutralUserMessage(candidate).events[0].content[0].text;
  assert.match(text, /message_ts=1\.2/);
  assert.doesNotMatch(text, /thread_ts=/);
  assert.match(text, /agent\.message output is not delivered to Slack/);
  assert.match(text, /Please inspect this$/);
});

test("keeps real Slack thread replies in their thread while making root messages top-level", () => {
  const directReply = candidateFromSlackEnvelope({ ...base, event_id: "EvDmdirect123", event: { channel: "D_1", channel_type: "im", event_ts: "1.3", text: "follow up", thread_ts: "1.2", ts: "1.3", type: "message", user: "U_ARMIN" } }, config);
  assert.ok(directReply);
  assert.equal(directReply.replyDefault, "thread");
  assert.match(neutralUserMessage(directReply).events[0].content[0].text, /thread_ts=1\.2/);
});

test("accepts all configured general messages while retaining mention and thread attention", () => {
  const mention = candidateFromSlackEnvelope({ ...base, event: { channel: "C_GENERAL", channel_type: "channel", event_ts: "2.1", text: "<@U_PROVIBOT> investigate", ts: "2.1", type: "message", user: "U_MEMBER" } }, config);
  assert.ok(mention);
  assert.equal(mention.requiresActiveThread, false);
  assert.equal(mention.attention, "mention");
  assert.equal(mention.replyDefault, "top_level");
  const reply = candidateFromSlackEnvelope({ ...base, event_id: "EvABCDEFGHIJ", event: { channel: "C_GENERAL", channel_type: "channel", event_ts: "2.2", text: "any progress?", thread_ts: "2.1", ts: "2.2", type: "message", user: "U_MEMBER" } }, config);
  assert.ok(reply);
  assert.equal(reply.requiresActiveThread, true);
  assert.equal(reply.attention, "thread");
  const ambient = candidateFromSlackEnvelope({ ...base, event: { channel: "C_GENERAL", channel_type: "channel", text: "ordinary chatter", ts: "2.3", type: "message", user: "U_MEMBER" } }, config);
  assert.ok(ambient);
  assert.equal(ambient.attention, "ambient");
  assert.equal(ambient.replyDefault, "top_level");
  assert.equal(candidateFromSlackEnvelope({ ...base, team_id: "T_OTHER", event: { channel: "D_1", channel_type: "im", text: "wrong workspace", ts: "3.1", type: "message", user: "U_MEMBER" } }, config), null);
});

test("accepts a Slack attachment as a neutral file reference without forwarding its private URL", () => {
  const candidate = candidateFromSlackEnvelope({ ...base, event_id: "EvAttachment123", event: { channel: "D_1", channel_type: "im", files: [{ id: "F123456", url_private: "https://files.slack.com/private" }], text: "", ts: "4.1", type: "message", user: "U_ARMIN" } }, config);
  assert.ok(candidate);
  const text = neutralUserMessage(candidate).events[0].content[0].text;
  assert.match(text, /attachment_file_ids=F123456/);
  assert.doesNotMatch(text, /url_private|files\.slack\.com/);
});
