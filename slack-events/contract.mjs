import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;

function string(value) {
  return typeof value === "string" ? value : "";
}

function threadReply(event) {
  return typeof event.thread_ts === "string" && event.thread_ts !== event.ts;
}

function fileIds(event) {
  if (!Array.isArray(event.files)) return [];
  return event.files
    .map((file) => typeof file?.id === "string" ? file.id : "")
    .filter((id) => /^[A-Z][A-Z0-9]{4,127}$/.test(id));
}

export function verifySlackSignature({ body, now = Date.now(), secret, signature, timestamp }) {
  if (!secret || !/^v0=[a-f0-9]{64}$/i.test(string(signature))) return false;
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt * 1000) > MAX_SIGNATURE_AGE_SECONDS * 1000) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const received = Buffer.from(signature, "utf8");
  const calculated = Buffer.from(expected, "utf8");
  return received.length === calculated.length && timingSafeEqual(received, calculated);
}

export function threadKey(channelId, threadTs) {
  return `thread:${channelId}:${threadTs}`;
}

export function eventKey(eventId) {
  return `event:${eventId}`;
}

export function neutralUserMessage(candidate) {
  const event = candidate.event;
  const request = typeof event.text === "string" ? event.text : "";
  const references = fileIds(event);
  const context = [
    "Slack event received.",
    `sender=${event.user}; channel=${event.channel}; conversation_type=${candidate.conversationType}; attention=${candidate.attention};`,
    `message_ts=${event.ts}; event_ts=${event.event_ts ?? event.ts}; event_id=${candidate.eventId}; reply_default=${candidate.replyDefault}.`,
  ];
  if (candidate.threadTs) context.push(`thread_ts=${candidate.threadTs}.`);
  if (references.length) context.push(`attachment_file_ids=${references.join(",")}. Read an attachment only when it is material to the request, using the mounted Slack MCP server.`);
  context.push("This user.message is inbound activation only. Any response that must be visible in Slack requires a Slack MCP message-send tool call to the channel above; agent.message output is not delivered to Slack.");
  context.push("Unmodified request follows:", request || "[No message text; the attachment reference above is the request.]");
  return {
    events: [{
      type: "user.message",
      content: [{
        type: "text",
        text: context.join("\n"),
      }],
    }],
  };
}

/**
 * Classifies a signed Slack event without making an activation decision. The
 * worker checks durable thread state later so a thread cannot become an
 * unbounded proactive wake source between Lambda invocations.
 */
export function candidateFromSlackEnvelope(envelope, config) {
  if (!envelope || envelope.type !== "event_callback" || envelope.team_id !== config.teamId) return null;
  const event = envelope.event;
  if (!event || event.type !== "message" || event.bot_id || event.subtype || event.is_ext_shared_channel || event.user === config.serviceUserId) return null;
  if (typeof envelope.event_id !== "string" || !/^Ev[A-Za-z0-9_-]{8,200}$/.test(envelope.event_id)) return null;
  const hasText = typeof event.text === "string" && event.text.trim();
  if ((!hasText && fileIds(event).length === 0) || typeof event.channel !== "string" || typeof event.ts !== "string") return null;
  const inThread = threadReply(event);
  if (event.channel_type === "im") {
    return {
      attention: "direct",
      conversationType: "dm",
      event,
      eventId: envelope.event_id,
      replyDefault: inThread ? "thread" : "top_level",
      threadKey: null,
      threadTs: inThread ? event.thread_ts : null,
      requiresActiveThread: false,
    };
  }
  if (event.channel !== config.generalChannelId || event.channel_type !== "channel" || event.is_ext_shared_channel) return null;
  const threadTs = inThread ? event.thread_ts : event.ts;
  const mentioned = typeof event.text === "string" && event.text.includes(`<@${config.serviceUserId}>`);
  return {
    attention: mentioned ? "mention" : inThread ? "thread" : "ambient",
    conversationType: "channel",
    event,
    eventId: envelope.event_id,
    threadKey: threadKey(event.channel, threadTs),
    replyDefault: inThread ? "thread" : "top_level",
    threadTs: inThread ? event.thread_ts : null,
    requiresActiveThread: inThread && !mentioned,
  };
}
