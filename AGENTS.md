# SquadWaddle — project instructions

## Product

Build a Discord app that helps busy gamers arrange patient, time-bounded group play. The first game is Marathon. Novey wants to use this product himself. Keep each increment runnable and explain the visible result in plain language.

Read README.md and docs/PRODUCT.md before changing scope. Read docs/NEXT-STEPS.md before choosing the next milestone. This repository is the handoff context; a new agent task should not assume it has the full planning conversation.

## Accepted requirements

- First format: three total seats including the host. This is our pilot format, not a claim that every activity requires three players.
- Explicit start and end, a real IANA time zone, and a clear finish expectation.
- Create privately, preview, then explicitly publish. Never post merely because AI extracted a request.
- Identity comes from authenticated Discord interactions. Never trust user-supplied acting IDs.
- Sharing a full Bungie Name is optional and chosen separately for each session. The host gets the same choice.
- Public cards must not contain Bungie Names. Only current confirmed participants may retrieve the opted-in group names privately.
- Joining without sharing remains fully supported: “I’ll arrange my in-game connection with the host.”
- Saving a name does not verify ownership, link a Bungie account, or enable in-game invitations.
- Private personal ratings are deferred pending the Discord policy question. Do not add live scores, relationship profiling, rankings, or person-specific matching.
- Find only real, accessible sessions. AI must never invent available players or silently join a group.
- No public launch, paid infrastructure, purchases, or external messages have been authorized by the starter implementation.

## Engineering

Native TypeScript with erasable syntax, Node 24.12+ within the 24.x line, built-in SQLite and node:test. No package installation is needed. Node runs the TypeScript here but does not type-check it. Do not claim that npm test performs a static type check.

Keep the domain rules separate from Discord transport and any later AI extraction. Use transactions for capacity and mutations. Sharing snapshots, permission checks and time calculations are deterministic application rules; an LLM must not decide them.

Run `npm test` and `npm run demo` after relevant changes. Add tests for material behavior or privacy risks, not assertions that only repeat implementation details. Keep live tokens, databases and personal data out of source control and logs.

The starter is not production-ready. Resolve the limitations in docs/NEXT-STEPS.md before a live pilot. Update the documentation whenever implemented behavior changes.
