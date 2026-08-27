# ProVIBot

ProVIBot is a Slack agent with a persistent Alder identity, including its wallet. You can send it a direct message, mention it in its configured ambient channel, or continue a task in an existing thread. Its managed session uses the tools and relevant Slack files it needs for the work.

This repository sets up and operates a ProVIBot deployment. It keeps the Slack credential synchronized, renews the managed session, deploys the Slack event receiver, and stops hosted resources without replacing ProVIBot's Alder identity.

> ProVIBot works when you bring it into a conversation. It does not watch Slack in the background or begin tasks on its own, and it never uses funds without a request from a teammate.

## Deployment model

A ProVIBot deployment has four main pieces:

- one funded Alder identity for ProVIBot, including its wallet;
- one active Claude Managed Agents session, with an attached memory store and Vault;
- one Slack app and one regular Slack service user for ProVIBot; and
- one AWS receiver that accepts signed Slack events and forwards them to the managed session.

ProVIBot's Alder identity is preserved across launches, session renewals, and shutdowns. Its wallet is part of that identity, not a separately provisioned resource. The hosted session can be replaced without creating a new identity.

Before you begin, make sure the organization that owns ProVIBot, its identity, the Slack app, the Slack service user, and the AWS account already exist. To reuse an established ProVIBot identity, obtain the gitignored local identity record through a private handoff before running `npm start`. Without it, the launcher treats the machine as a first deployment. The record's file inventory and transfer procedure belong in private operator documentation, not this repository. The launcher does not create a new Slack app or organization.

Throughout this guide, **Alder identity** is the persistent identity that authenticates ProVIBot to Alder services. It includes the wallet and usage state associated with that identity: they serve different purposes, but cannot be provisioned, transferred, or used independently. **Managed agent** means the policy and tool configuration hosted by Anthropic, while **managed session** means the active runtime created from it. These resources are linked, but they are not interchangeable.

## Using ProVIBot in Slack

| Incoming Slack activity | Expected behavior |
| --- | --- |
| Direct message | A complete request receives a top level reply. An obviously incomplete fragment may wait for the next message. |
| `@ProVIBot` mention in the configured ambient channel | ProVIBot replies at the channel level. |
| Reply in an existing thread | ProVIBot continues in that thread. |
| Ordinary message in the configured ambient channel | The message becomes ambient context. ProVIBot normally remains silent unless it can materially answer, correct, unblock, or advance work it owns. |
| Attached file | The normalized activation includes the Slack file ID. ProVIBot retrieves the file through Slack MCP when it is relevant to the request. |

A visible reply is always sent by ProVIBot through the Slack Model Context Protocol (MCP) server. Internal managed session messages are not copied into Slack.

## Quickstart

### What you need

- Node.js 22.
- The configuration values required by [`.env.example`](.env.example).
- A Slack browser session signed in as the bot's dedicated Slack service account, never an individual teammate's, when authorization must be created or refreshed.
- An AWS CLI profile only when deploying or updating the standing Slack receiver.

Then install, configure, validate, and launch:

```bash
npm ci
cp .env.example .env
# Fill .env with the configuration values described below.
npm run check
npm start
```

If `.env` does not yet contain a valid `PROVIBOT_SLACK_ACCESS_TOKEN`, run `npm run authorize-slack` after adding the Slack client details and before `npm start`. Complete that flow while signed in as the bot's dedicated Slack service account, never an individual teammate's.

`npm start` is a provisioning command, not a long running local server. It provisions or validates the current hosted stack, synchronizes the Slack OAuth credential into the existing Vault, initializes durable memory when needed, and exits.

The launcher is idempotent: when the local identity record points to the existing ProVIBot agent, it reuses that identity rather than creating another agent or wallet.

### Verify it works

After `npm start` completes successfully, check the three deterministic Slack routes:

1. Send ProVIBot a direct message and ask for a brief acknowledgement.
2. Mention `@ProVIBot` in the configured ambient channel and ask for a brief acknowledgement.
3. Reply to ProVIBot inside an existing thread and confirm that the response remains in the same thread.

Ordinary, unmentioned messages in the configured ambient channel are not a deterministic health check because ProVIBot is intentionally selective about responding to ambient conversation.

## How it works

For Alder's architecture, account model, and payment grammar, see the [Alder documentation](https://app.alder.exchange/docs).

For each relevant Slack event:

1. Slack sends an HTTP request to the Lambda Function URL.
2. The ingress verifies the Slack request signature before accepting the event.
3. The receiver deduplicates the event and places it on an Amazon SQS FIFO queue so ProVIBot activations are processed in order.
4. The activation worker sends one normalized activation to ProVIBot.
5. ProVIBot resumes the managed session associated with its identity.
6. The session reads its policy, tools, memory, and credentials held in the Vault, then performs the work.
7. Any visible acknowledgement, progress update, blocker, or result is posted by ProVIBot through Slack MCP.

The inbound receiver and the outbound Slack identity are deliberately separate. The receiver verifies and forwards events; it does not speak as ProVIBot. The managed session posts through the Slack user credential held in the Vault.

## Components

| Component | Responsibility |
| --- | --- |
| Alder identity with wallet | The durable Alder identity that authenticates ProVIBot and provides its funding and usage state. The identity and wallet have distinct roles but cannot exist or operate independently. |
| Alder Services | The Alder service offering that authorizes and admits work under the Alder identity, then activates the managed session. |
| Managed agent session | The temporary Anthropic execution runtime, activated by Alder Services and returned to idle after work. |
| Session connections and resources | Lets the session communicate through Slack and Alder, then use its native tools, durable memory, and Vault-held credentials. |
| `slack-events/` | Verifies Slack signatures, deduplicates events, serializes delivery, and forwards bounded activations. |
| This repository | Provisions, validates, renews, deploys, and stops the existing stack. |

## Slack configuration

### Required workspace metadata

| Setting | Source of truth | Required value or behavior |
| --- | --- | --- |
| Workspace | `PROVIBOT_SLACK_TEAM_ID` | The configured Slack workspace ID. |
| Service user | `PROVIBOT_SLACK_USER_ID` | The regular Slack user ID belonging to ProVIBot. |
| Ambient channel | `PROVIBOT_SLACK_CHANNEL_ID` | The configured ambient channel ID. |
| Event subscriptions | Slack app settings | `message.im` and `message.channels`. |
| Request verification | `PROVIBOT_SLACK_SIGNING_SECRET` | Receiver-only signing secret from the Slack app's **Basic Information** page for verifying incoming Slack requests. |
| Outbound identity | Slack credential held in the Vault | The ProVIBot service user, never the Lambda receiver or local launcher. |
| OAuth approval identity | Slack browser session | The bot's dedicated Slack service account, never an individual teammate's. |
| Thread placement | Incoming message metadata | Root DMs and root mentions reply at the top level; genuine thread replies remain threaded. |

The Slack user credential requires these scopes:

```text
chat:write

channels:history
channels:read

groups:history
groups:read

im:history
im:read
im:write

files:read

users:read
users:read.email
```

Event delivery uses signed Slack Events API requests; it does not use a Socket Mode app token or bot token.

## Local configuration

Create the ignored local configuration file from the committed template:

```bash
cp .env.example .env
vi .env
```

| Group | Variables | When required | Obtain from |
| --- | --- | --- | --- |
| Organization | `ALDER_ORG_API_KEY` | Normal launch and operation | The organization that owns ProVIBot. |
| ProVIBot connection | See [`.env.example`](.env.example) | Normal launch, activation, and managed agent tools | The configuration provided for the deployment. |
| Slack user OAuth | `PROVIBOT_SLACK_ACCESS_TOKEN`, `PROVIBOT_SLACK_CLIENT_ID`, `PROVIBOT_SLACK_CLIENT_SECRET` | Slack MCP authorization; the client secret is needed only for a confidential client | `npm run authorize-slack` and the Slack app configuration. |
| Slack routing | `PROVIBOT_SLACK_TEAM_ID`, `PROVIBOT_SLACK_USER_ID`, `PROVIBOT_SLACK_CHANNEL_ID` | Normal event routing | Slack workspace, ProVIBot user, and configured ambient-channel metadata. |
| Slack request verification | `PROVIBOT_SLACK_SIGNING_SECRET` | Standing receiver only; verifies incoming Slack requests | Slack app **Basic Information**. |
| Agent defaults | `PROVIBOT_AGENT_NAME`, `PROVIBOT_FUNDING_NANODOLLARS` | Optional | Local display name and initial funding defaults; the funding value is expressed in nanodollars. |

If the deployment sits behind preview authentication, supply those credentials through the documented variables for that deployment.

The repository ignores `.env` and `.local-state/`. Keep credentials in their intended stores:

- AWS credentials in the operator's CLI profile or SSO cache;
- Slack and MCP credentials in the Anthropic Vault after synchronization; and
- local bootstrap values in the ignored `.env` file.

Do not put credentials in committed files, managed memory, or Slack messages.

## Commands

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the exact locked dependencies, including the public `@alderinc/sdk` package from npm. |
| `npm run check` | Run syntax checks and focused unit tests. |
| `npm start` | Provision or validate the current hosted stack, synchronize policy and Slack OAuth, initialize memory when needed, and exit. |
| `npm run authorize-slack` | Run the local PKCE OAuth flow for the ProVIBot service user. |
| `npm run renew` | Settle the active session and create its replacement on the same agent, wallet, Vault, environment, and memory store. |
| `npm run stop` | Settle the active session and remove hosted resources while preserving ProVIBot's identity. |
| `npm run bootstrap:slack-events-deployer` | Perform the one time administrator setup for the narrowly scoped deployment role. |
| `AWS_PROFILE=<profile> npm run deploy:slack-events` | Deploy or update the standing Slack Events receiver. |

## Operations

### Refresh Slack authorization

Refresh the Slack authorization after scopes change, authorization is revoked, or the credential expires:

```bash
npm run authorize-slack
```

In Slack, register the exact redirect URI `http://localhost:8765/slack/oauth/callback`, then open the printed URL while signed in as the bot's dedicated Slack service account. After the local callback reports success, synchronize the resulting credential into the existing Vault:

```bash
npm start
```

Using an individual teammate's Slack account would make ProVIBot act with the wrong identity and permissions.

### Deploy the standing Slack receiver

The standing receiver is deployed once and then updated in place:

```bash
AWS_PROFILE=your-local-profile npm run deploy:slack-events
```

The deployment uses a narrowly scoped role dedicated to this receiver. Run it only from the identity record held by an operator and obtained through the private handoff. AWS credentials stay in the local CLI profile or SSO cache and are never copied into `.env`.

Slack calls the resulting Lambda Function URL directly. Keep the URL configured as the app's Event Subscriptions request URL, and keep signature verification enabled at the ingress. The URL routes requests; the Slack signing secret establishes their authenticity.

Account administrators perform the deployer role bootstrap once:

```bash
npm run bootstrap:slack-events-deployer
```

### Renew the managed session

Managed Agents retains a session's event history until that session is deleted. Its sandbox checkpoint is separate: the filesystem, installed packages, and other sandbox state are retained for 30 days from sandbox creation, and activity does not extend that window. Context that spans sessions therefore belongs in the shared memory store or in captured outputs, not only in the session filesystem.

Renew near that boundary or after a system policy revision:

```bash
npm run renew
npm start
```

Renewal replaces the active session while preserving ProVIBot's identity, wallet, environment, Vault, and memory store. No new identity or activation authorization is required; both remain associated with ProVIBot.

### Stop the hosted stack

Use the stop command for a deliberate shutdown:

```bash
npm run stop
```

The command settles the active session and removes the hosted resources managed by this repository. It preserves ProVIBot's identity so a later launch can resume with the same ProVIBot rather than creating a replacement.

## Durable agent context

Within the attached memory store, ProVIBot maintains four compact records:

| Memory record | Contents |
| --- | --- |
| `/provi/active-work.md` | Work ProVIBot currently owns, including dependencies, status, and the next meaningful action. |
| `/provi/decisions.md` | Confirmed decisions, their rationale, and whether a later decision superseded them. |
| `/provi/team-context.md` | Durable project facts, roles, constraints, and the sources needed to act on them. |
| `/provi/lessons.md` | Verified operational lessons, failure modes, and corrections. |

These records are curated operational state, not chat logs. ProVIBot should not write casual conversation, credentials, private Slack artifacts, or unverified claims into durable memory.

## Credential and trust boundaries

- Slack signs inbound Events API requests; the Lambda ingress verifies that signature before forwarding an event.
- The receiver deduplicates and orders activations before they reach the managed session.
- The receiver cannot post as ProVIBot. Visible Slack messages require the Slack MCP credential held in the Vault.
- The local launcher synchronizes credentials but does not retain them in committed source.
- The managed agent receives only the MCP servers and tools declared for it. Credentials remain separate in the Vault.
- The launcher remains an operations tool. It does not acquire GitHub, CI, documentation, or credentials for particular tasks on behalf of the agent.

## Repository map

| Path | Responsibility |
| --- | --- |
| [`src/run.mjs`](src/run.mjs) | Idempotent launch, hosted agent policy synchronization, Vault credential synchronization, and memory initialization. |
| [`src/renew.mjs`](src/renew.mjs) | Safe session replacement on the existing ProVIBot identity. |
| [`src/stop.mjs`](src/stop.mjs) | Session settlement and hosted resource teardown. |
| [`src/authorize-slack.mjs`](src/authorize-slack.mjs) | Local PKCE callback, token capture, and Slack credential validation. |
| [`src/persona.mjs`](src/persona.mjs) | ProVIBot behavior, Slack routing, usage boundaries, and durable memory policy. |
| [`slack-events/`](slack-events/README.md) | Signed Events API ingress, FIFO queue, and bounded activation relay. |
| [`test/`](test/) and [`slack-events/test/`](slack-events/test/) | Persona, routing, signature, and package boundary tests. |

## Adding a capability

Add external capabilities through the managed agent boundary rather than through the launcher:

1. Declare the MCP server and permitted tools on the managed agent configuration.
2. Register the corresponding credential in the Anthropic Vault.
3. Update the persona or operating policy only when the new tool changes expected behavior.
4. Add focused tests for routing, permission, and failure behavior.
5. Run `npm run check`, then `npm start`. Renew the session when the change requires a new session or follows a system policy revision.

GitHub, CI, documentation, and other connectors should follow this pattern. The launcher should remain limited to provisioning and lifecycle operations; it should not accumulate task-specific integration logic or repository credentials.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `npm ci` cannot download the SDK | Confirm access to `registry.npmjs.org` and run `npm ci` again. No npm login or read token is required for `@alderinc/sdk`. |
| `npm start` attempts or refuses an unexpected identity operation | Preserve `.local-state/` and inspect the existing identity record before changing anything. Do not delete local state merely to force a fresh launch. |
| ProVIBot receives no Slack activity | Confirm Event Subscriptions are enabled, the Lambda Function URL is current, the signing secret matches, the receiver is deployed, and the workspace/channel/user IDs are correct. |
| ProVIBot can read Slack but cannot post | Reauthorize while signed in as the bot's dedicated Slack service account, then run `npm start` to synchronize the Vault credential. |
| Session files or installed tools are missing after an older session resumes | Treat the sandbox as expired after its 30-day retention window. Recover durable state from memory or captured outputs and renew the session. |
| Replies appear in the wrong place | Check whether the incoming event contained a genuine Slack thread timestamp and run the routing tests in `test/` and `slack-events/test/`. |

## Platform references

- [Alder documentation](https://app.alder.exchange/docs)
- [Claude Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview)
- [Claude Managed Agents session events and sandbox retention](https://platform.claude.com/docs/en/managed-agents/events-and-streaming)
- [Claude Managed Agents Vault authentication](https://platform.claude.com/docs/en/managed-agents/vaults)
- [Slack Events API](https://docs.slack.dev/apis/events-api/)
- [Amazon SQS FIFO delivery behavior](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-understanding-logic.html)

## License

MIT-licensed. "Alder" and the Alder marks are trademarks of the project's owner and are not licensed under the MIT grant. The persona and deployment pattern may be adapted freely, which is the point of publishing this repository.
