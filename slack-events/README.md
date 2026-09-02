# ProVIBot Slack Events receiver

This is the standing ingress for messages addressed to the existing regular
Slack user **ProVIBot**. It is not an MCP server, Slack bot, task runner, or
payment client. The existing Vault-held Slack MCP credential remains the
agent's only Slack voice.

The public Lambda Function URL verifies Slack's HMAC signature and queues a
candidate event. A single SQS worker deduplicates it, validates the configured
workspace plus either a direct message or a message in the configured
`#general` channel, then forwards one normalized ingress event carrying a
neutral, verbatim `user.message`. Its scoped Services access token can only
resolve the connection's current active session and deliver that event. The
event states whether it is a direct message, direct mention,
active-thread continuation, or ambient channel context; the hosted agent alone
decides whether ambient context warrants a reply.

The worker has no Slack API token. Slack content is neither logged nor written
to the routing table; DynamoDB retains only event and thread identifiers with a
seven-day expiry. The scoped Services ingress token is stored only in the
receiver's encrypted configuration. The worker is serialized, so it cannot
race another delivery for this connection.

## Deployment

Set `PROVIBOT_SLACK_SIGNING_SECRET` in the ignored root `.env` from the
existing Slack app's **Basic Information** page. This receiver-only value is
stored in the receiver configuration for Slack HMAC verification. One account
administrator first runs:

```bash
npm run bootstrap:slack-events-deployer
```

This creates the narrow deployment IAM role and prints its name. It trusts only
identities from this AWS account; each operator also needs `sts:AssumeRole`
permission for that role through their own IAM Identity Center permission set:

```json
{
  "Effect": "Allow",
  "Action": "sts:AssumeRole",
  "Resource": "arn:aws:iam::<account-id>:role/<deployer-role-name>"
}
```

Every subsequent operator deploys with their own authenticated AWS CLI profile:

```bash
AWS_PROFILE=their-local-profile npm run deploy:slack-events
```

The deployment command assumes the dedicated role automatically. It rejects
AWS access-key environment variables: local credentials belong to the AWS CLI
profile or SSO cache, never this repository's `.env`.

AWS root cannot assume roles. A root-backed CLI may perform the first deployment
only with an explicit, one-command override:

```bash
PROVIBOT_ALLOW_ROOT_BOOTSTRAP=1 npm run deploy:slack-events
```

That override is deliberately not read from `.env` and is not the standing
operational path. Once an IAM Identity Center operator has `sts:AssumeRole` for
the deployer role, their normal profile needs no override.

The owner-side deployment step recovers a narrowly scoped Services ingress
token for the existing connection, then creates or updates the Lambda ingress and worker, encrypted FIFO
handoff queue, DynamoDB routing state, least-privilege roles, and a
dedicated Secrets Manager record (name printed by the deploy script). It writes
only non-secret resource identifiers to `.local-state/provibot-slack-events.json`
and prints the Request URL to paste into the existing Slack app's Event
Subscriptions page.

Subscribe **on behalf of the ProVIBot user** to `message.im` and
`message.channels`; reinstall the existing app as ProVIBot after scope changes.
Do not install or speak to a second app. `message.channels` is accepted only in
the configured `#general` channel. Root events are marked for top-level reply;
only real Slack thread replies carry a `thread_ts` routing hint. The receiver
does not post, interpret requests, manage windows, or make payment decisions.

## Attachment references

The agent's Vault-held Slack MCP user credential may use `files:read` for an
attachment that arrives in an accepted event. The receiver forwards only a
validated file ID and never a private URL, file body, or credential. Do not add
`file_shared` subscriptions or `search:read.files`: those would turn unrelated
file activity into an activation source, contrary to the standing reactive
model.

## Operational boundary

This receiver is the sole ingress. The agent remains reactive: no scheduler,
polling loop, proactive spending, or autonomous wake source exists. A session
renewal does not require Slack reauthorization or a new payment relationship:
the ingress token remains bound to the existing Services connection while the
receiver resolves its active session at delivery time.

Services acknowledges an ingress event only after durably recording it; this
receiver retries only when that handoff itself cannot be made. System-health
monitoring belongs in standard infrastructure tooling, not in this receiver.
