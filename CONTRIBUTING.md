# Contributing to ProVIBot

ProVIBot is an operator package for one persistent, reactive teammate.
Changes must preserve its existing Alder agent identity and wallet, the single
Slack service-user identity, and the reactive-only activation model.

## Before opening a change

```bash
npm ci
npm run check
```

Keep code, focused tests, and the applicable operational documentation aligned.
Do not add, print, or commit `.env` or `.local-state/` contents. Inspect or use
them only during explicitly authorized operator work.

## Implementation rules

- Do not create a replacement Alder agent, wallet, Slack app, or Slack user to
  work around an error. Preserve local state and fail closed when identity is
  uncertain.
- Keep the Slack receiver a narrow relay: verify signed events, forward bounded
  normalized activations, and let the hosted agent decide and send Slack replies.
  Do not add polling, scheduling, file-only wakeups, or autonomous spending.
- Keep deployment authority in the operator's AWS profile and dedicated deployer
  role. Local application configuration is not a credential store for AWS keys.
- Use idempotency keys and durable checkpoints for operations that cross process
  or service boundaries.

## Comments and review

Prefer names and small functions for ordinary control flow. Add a code comment
only when it explains a non-obvious invariant, security boundary, external
service limitation, or failure-recovery decision. Do not restate the code,
leave decorative section banners, or add untracked TODOs.

When changing one of those invariants, update its nearby comment and its focused
test in the same change. Keep behavior changes separate from broad formatting or
documentation cleanup.
