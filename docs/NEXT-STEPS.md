# The next build steps

## First: run the starter on Novey's MacBook

Open this folder in Codex. Start with:

> Read AGENTS.md, README.md, docs/PRODUCT.md and VALIDATION.md. This is my existing SquadWaddle starter for a Marathon Discord app. Inspect the current files, check my Node version, then run the existing tests and local demo. Explain what is implemented and identify the next small milestone. Keep session-level Bungie Name sharing optional. Keep all credentials local. Do not add ratings or a social feed. Do not deploy or post invitations as part of this setup.

There is no need to build the project again from a blank prompt. This folder contains code, tests and accepted requirements. This chat remains useful for deciding the product's direction.

## Milestone 1 — one private, real Discord session

The starter already has a signed interaction endpoint and command definitions. The next milestone is a complete private integration test that demonstrates the actual Discord experience.

Follow the [private Discord test walkthrough](PRIVATE-DISCORD-TEST.md) for the Mac Terminal check, app installation, local settings and the three-player rehearsal.

Work required:

1. Use **SquadWaddle** as the Discord application name. Configure it for a private test server and channel with credentials stored locally. Record the exact installation and permission settings using the current official Discord instructions.
2. Use a reachable HTTPS test endpoint. Decide deliberately whether it runs from the MacBook during testing or from a chosen host. Do not buy hosting as a prerequisite for the local demo.
3. Register `/session` only in that test guild. Verify the endpoint, command availability and supported message/button payloads in live Discord.
4. Test a host and two consenting testers: private draft, explicit publish, both joining choices, fourth-seat rejection, participant-only names, leave, revoke and cancel. Confirm nobody sees a game ID in a public message.
5. Publish retries now receive a private acknowledgement across restarts when using the same SQLite file. Next, record the public message ID when delivery can be confirmed, refresh the original card after membership changes, and reconcile sessions whose public card may be missing after a crash. A retry alone cannot establish whether Discord received the original card.
6. Establish minimal participant-data retention, full deletion and moderation/reporting behavior before inviting an external community. Delete test data deliberately after the integration test.

Success is a usable, correctly scoped Discord interaction. Automated local tests alone do not establish this milestone.

## Milestone 2 — reduce the typing

Add one natural-language input, initially text. Keep the parser separate from the session store. It proposes a structured draft; deterministic code validates it and the user confirms it.

The input should extract game, activity, date, start/end, time zone, requested extra players and stated expectations. Remember the user's chosen defaults where they consent. Ask a brief follow-up for genuinely missing or ambiguous details; do not repeatedly request information the app already has.

Important examples:

- “Two more” means three total when the speaker is hosting.
- “Saturday at noon” needs a reference date and the user's chosen zone. Show the exact date before publishing.
- “Pacific” should resolve to a saved region such as America/Los_Angeles, with daylight-saving rules, rather than permanently assuming UTC−8.
- “Noon to 1:30” is a play window, not a promise of completing an entire activity.
- “Any groups tonight?” must query real sessions accessible in the current scope. It must never invent players, parties or join confirmations.

The model does not decide authorization, capacity, consent, compatibility or whether to post. Verify any selected model/API's current documentation, pricing and data handling before connecting it. No OpenAI API integration exists in this starter.

## Milestone 3 — make scheduled sessions dependable

Add opt-in reminders and an end-time notice with a persistent job store, delivery records, restart recovery and cancellation handling. Define delivery channels and frequency with the user. Use bounded retries and avoid duplicate notifications.

Then add a waitlist if the pilot demonstrates a need. A waitlisted person is not a confirmed group member and must not receive shared Bungie Names. Changing capacity or promoting someone needs a deterministic, tested transition.

## Milestone 4 — learn from a small community

Use the eight-session pilot in docs/PRODUCT.md. First validate that people can form a group, start near the planned time, enjoy the pace and return. Measure coordination effort without collecting unnecessary conversation content or inferring personal relationships.

A paid organizer plan is a later hypothesis. Recheck current Discord monetization eligibility, applicable platform requirements and Washington business obligations before taking payments. No business registration or payment setup is included in this code starter.

## Work to keep parked

A standalone social network, multi-game expansion, public player ratings, private ratings tied to live Discord identities, voice agents, social posting, external gamer-account OAuth and autonomous invitations are not required to make the first session useful. Private personal ratings remain a policy question, even though they would be visible only to their owner.

## Known technical decisions

- Native TypeScript keeps the initial runtime simple. Add an explicit static type-checking toolchain when needed; execution tests are not a substitute for type checks.
- SQLite is appropriate for this bounded, single-instance prototype. Choose hosting and concurrency architecture before expanding to multiple service instances.
- Discord signed requests authenticate the transport; the domain layer receives a trusted Actor. Never expose domain methods directly as a browser API that accepts arbitrary acting user IDs.
- A saved Bungie Name is self-reported. Account verification and in-game invites require separate supported integrations; do not imply those features exist.
- The current list shows the first five open sessions and has no pagination. Improve discovery when the pilot exceeds that scale.
- Session editing and host transfer are not implemented. A host can cancel and create another session.
