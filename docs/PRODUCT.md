# Product decisions

Updated November 25, 2026. Novey chose **SquadWaddle** for the service and its Discord app.

CoHop was an earlier candidate. A November 25 name check found that Cohop Games already provides video-game production services at `cohop.games`, and a collaborative trip planner uses `cohop.app`. The exact `.com` and `.gg` domains are also registered. [Cohop Games](https://cohop.games/) · [Trip planner](https://cohop.app/) · [.com registry](https://rdap.verisign.com/com/v1/domain/cohop.com) · [.gg registration](https://www.whois.com/whois/cohop.gg)

## The useful result

Someone finishes work, wants a relaxed game with other people, and has a limited window. SquadWaddle should help them find or create an appropriate session without repeatedly filling in the same information or exchanging game IDs in chat.

The first community is a willing, moderated adult Discord community. The first game is **Marathon**, selected by Novey. Keep the product small enough for one person to build and use.

## The intended experience

Eventually a player can say: “Find me two people for a patient Marathon learning session Saturday, noon to 1:30 Pacific.” The app will interpret that request, ask only about essential ambiguities, show a clear preview, and wait for a deliberate Publish or Join action. For a search, it will suggest actual sessions the player can access.

The visible menu is `/session create`, `/session find`, and `/session help`. Create accepts a local Marathon scheduling sentence such as “Four players total for Marathon on 2026-12-11 from 6:30 pm to 8:00 pm Pacific for Expedition practice.” It accepts a `YYYY-MM-DD` date or a full weekday in the selected zone. The private preview shows the activity, total seats, and localized Discord times. The host can add a platform and explicitly switch sharing from its default of No. **All weekend** creates date-only availability for Saturday and Sunday. The host picks an exact slot on one day before publishing.

Before publishing, the organizer can edit an existing draft and recover the latest preview through **My drafts** in the original channel. The organizer publishes from the latest revision. After publication, the host confirms cancellation privately and the public card can reflect that status in place.

## Initial session rules

- 2–8 total seats including the host. Three is the default, and hosts can revise the size before publishing.
- A defined start and finish, shown in the player's local Discord time plus the organizer's chosen IANA zone.
- A patient learning expectation and a finish time that is a real boundary.
- Platform and cross-play preferences are participant-provided information. The app does not verify console settings, activity unlocks, purchases, skill or eligibility.
- The announced Expedition PvE mode is the intended initial activity to validate. Its three-run series does not mean a series will fit a particular availability window.
- The app coordinates players. They still connect inside the game themselves.

## Bungie Names and consent

Players may save a full name such as `ExampleRunner#1234`. It is self-reported. Discord sign-in and a saved name do not link or verify an external account.

Each session offers **Join & share my Bungie Name** and **Join only**. Sharing is a snapshot taken only on an explicit share action. Updating a profile does not silently change already shared session names. The participant can explicitly share again to update a snapshot, stop sharing, or clear their saved name and all existing snapshots.

**Show group IDs** is private to the requesting confirmed participant and includes only names whose owners opted in. Public cards contain no Bungie Names. A non-sharer is described as **ID not shared** and is reminded to arrange their connection with the host. Privacy choices are not evidence that someone is unready or unreliable.

Leaving ends future access; revoking sharing removes the name from future lookups. Previously displayed or copied information cannot be recalled. The application operator can access the database; this is not end-to-end encryption. Production retention and account-deletion behavior must be completed before collecting real participant data.

## Features deliberately deferred

More flexible scheduling sentences, natural-language search, live voice rooms, persisted reminders, waitlists, recurring sessions, preference-based discovery, multi-server matching, social sharing, external account OAuth and a standalone social feed are later increments. The local [voice-room lifecycle](VOICE-ROOMS.md) is exercised only with a mock adapter.

Novey's proposed 1–5 score is owner-only personal memory. It is not a public reputation system. Private ratings, notes about identifiable players, and person-specific matching remain deferred while the Discord Developer Policy question is resolved. Use fictional data for any design experiment involving them. Basic coordination must work independently.

## Business hypothesis

Players participate free. A possible later organizer plan is **$12 per Discord server per month**, subject to product value, platform eligibility and current monetization rules. That figure is a pricing hypothesis, not validated revenue.

Run a free eight-session pilot with one willing community. Initially recruit six to eight people who can share a time window. Observe starts, attendance, repeat participation and organizer time. Target six of eight sessions starting, 75% confirmed-seat attendance, and a meaningful reduction in manual coordination. At least eight eligible early participants are needed before using the proposed 50% two-week return threshold; otherwise report the sample as inconclusive. Aim for four later sessions that do not require Novey to host. Distinguish game-access problems and promotional incentives from product value.

Do not expand into every game or a social network until this small coordination loop earns repeat use.

## Reference material

- [Marathon Expedition Phase 1 announcement](https://www.bungie.net/7/en/News/Article/dev_deep_dive_expedition_phase_1) — activity details are announced information as of this document's date; recheck before enabling a live activity.
- [Marathon Cross Play Guide](https://help.marathonthegame.com/hc/en-us/articles/39004046491156-Marathon-Cross-Play-Guide) — platform compatibility and in-game connections.
- [Bungie Name Guide](https://help.marathonthegame.com/hc/en-us/articles/39003920615828-Bungie-Name-Guide) — names and numeric suffixes.
- [Discord Developer Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy) — review current requirements before collecting live participant data or introducing ratings and relationship features.

The longer business plan remains the separate planning reference. This document records the decisions needed to build the first increment.
