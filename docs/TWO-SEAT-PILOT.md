# Two-seat private text pilot

Use this runbook with one host and one consenting guest in a single approved private Discord channel. Run `npm test`, `npm run rehearsal`, and `npm run demo` on Node 24 first. The signed two-seat regression covers the flow locally. The two Discord clients confirm what the host and guest can actually see.

## Start the test

- Agree on the stop time. Use a dedicated test app, one exact guild/channel pair, and disposable SQLite. Verify the app, endpoint, and existing guild-only command before changing anything. Save the previous endpoint and command definition locally for rollback. Stop if any existing configuration is unexpected. Keep credentials out of chat, logs, and screenshots.
- Use the machine’s approved private HTTPS route, with signed interactions. Enable explicit Publish for this test and leave voice and automatic deletion off. Use fictional names and avoid any personal information in session text.
- The host privately saves `ExampleHost#1234` under **My Bungie ID** from `/session help`. Saving alone does not opt in to a session.

## Walk through one session

1. The host enters `Two players total for Marathon on 2026-12-11 at 6:30 pm Pacific for Expedition practice.` in the `request` field of `/session create`. Substitute a future date and time if needed. Confirm the host sees a private 6:30–8:30 pm Pacific preview with **Default duration · 2 hours**, two total seats, and sharing off. The guest should see no draft, card, or result in `/session find`.
2. Use **Edit** to change the sentence to an explicit range such as 6:30–8:00 pm, then review the updated private preview. Choose **Share my Bungie ID: Yes** for this fictional host name. That choice applies to confirmed teammates in this session, including people who join later.
3. Press **Publish**. Both clients should see one card at 1/2 seats with no Bungie Name. Before joining, the guest presses **Show group IDs** and should get a private denial.
4. The guest presses **Join** and **Join only**, then repeats that choice. The roster stays at 2/2 and the guest shares nothing. The guest presses **Show group IDs** and sees the host’s fictional name privately. The host sees the guest listed as **ID not shared**. To verify joining after the scheduled start in Discord, schedule a start within the agreed window and join just after it. The signed regression advances a fictional clock to exercise this boundary without waiting.
5. The guest presses **Leave**. The card returns to 1/2. A fresh **Show group IDs** press, including from an older card, denies access. A previously displayed private reply can still be seen or copied.
6. The host presses **Host Cancel** and **Confirm cancellation**, then **Refresh**. The original card shows the cancellation. `/session find` no longer lists it and **Join** is refused.

## Stop and roll back

Stop at the agreed cutoff or after the last check. If a draft is still private, discard it. Cancel any published test session and remove its test card as agreed with the server owner. Restore the prior guild command and endpoint only if the current values still match what this test set. Leave unexpected changes in place and record what needs review. Stop the test’s own server and temporary route, confirm the endpoint and guild command state, then dispose of the test database. Record only pass/fail outcomes.
