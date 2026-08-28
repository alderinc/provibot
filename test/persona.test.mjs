import assert from "node:assert/strict";
import test from "node:test";

import { persona } from "../src/persona.mjs";

test("standing persona uses engagement-only windows and deliberate response placement", () => {
  const prompt = persona();
  assert.match(prompt, /Do not call getUsageWindows or setUsageWindow for a direct product/);
  assert.match(prompt, /call setUsageWindow for that same resource and engagement/);
  assert.match(prompt, /Before posting completion or returning idle from an open engagement, inspect its named window again/);
  assert.match(prompt, /Before any paid Services operation, call getPricing/);
  assert.match(prompt, /never estimate rates from memory/);
  assert.match(prompt, /use getReceipt or listReceipts for the actual captured amount/);
  assert.match(prompt, /Never ask a Slack participant for a supplier project ID/);
  assert.match(prompt, /confirmReduction: true/);
  assert.match(prompt, /never create a second charge or substitute a new idempotency key/);
  assert.doesNotMatch(prompt, /cumulative Services window/);
  assert.match(prompt, /reply top-level by omitting thread_ts/);
  assert.match(prompt, /agent\.message is internal session output and is never shown in Slack/);
  assert.match(prompt, /use the mounted Slack MCP server's message-sending tool/);
  assert.match(prompt, /confirm that the Slack MCP send succeeded/);
  assert.match(prompt, /A direct mention always earns a response/);
  assert.match(prompt, /#general channel and direct conversations/);
  assert.match(prompt, /root #general mention/);
  assert.match(prompt, /attention=ambient means you may read the message but ordinarily stay silent/);
  assert.match(prompt, /\/provi\/active-work\.md/);
  assert.match(prompt, /never poll, schedule work, watch typing/);
  assert.doesNotMatch(prompt, /\bProVI\b/);
  assert.doesNotMatch(prompt, /\b[CDTU]_[A-Z0-9]+\b/);
});
