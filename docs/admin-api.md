# Synapse Admin API — Giveaways (v2)

For **admin.bostonblerds.com**. Synapse owns the giveaway data; the dashboard is its UI.
**Objects** (Giveaway, Platform, Rule, FormField, Person, Winner, Stats): [giveaway-object.md](giveaway-object.md). Design and reasoning: [giveaway-engine-v2-spec.md](giveaway-engine-v2-spec.md).

- **Base URL:** `https://api.bostonblerds.com/admin`
- **Auth:** every request sends `Authorization: Bearer <ADMIN_API_KEY>`. The key is a server-side secret: call this API from the dashboard's **server** only, never from the browser.
- **Who's acting:** every change (`POST` / `PATCH` / `DELETE`) must send `X-Admin-User: <signed-in admin's email>`. It's recorded in the audit log.
- **Dates:** ISO 8601 with offset, e.g. `2026-11-20T22:30:00-05:00`. Show them in Eastern time.
- **Errors:** `{ "error": "message" }` with 400 (invalid input), 401 (bad key), 404, 409 (conflict, e.g. overlapping giveaway), 502 (Instagram didn't respond), 503 (bot offline).
- **Optional fields** can be left out or sent as `null` (see giveaway-object.md for which `null`s clear). Read-only fields are ignored, so you can send back what you received.

---

## Giveaways

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/giveaways` | — | `Giveaway[]` (newest first) |
| POST | `/giveaways` | Giveaway fields | `201 Giveaway` · `409` if dates overlap another giveaway |
| GET | `/giveaways/:id` | — | `Giveaway` |
| PATCH | `/giveaways/:id` | Any Giveaway fields | `Giveaway` |
| POST | `/giveaways/:id/preview` | Same body as PATCH | **Dry run** of an edit, nothing saved (below) |
| POST | `/giveaways/:id/close` | — | `Giveaway` (closes early) |
| DELETE | `/giveaways/:id?confirm=<name>` | — | `{ deleted, id, name, entrants }` (below) |
| GET | `/giveaways/:id/audit` | — | Audit rows, newest first |

**Create:** `name`, `startsAt`, `endsAt`, `platforms` are required.

**Editing rules:** send each platform's **full rule list**. Include `id` for existing rules, omit it for new ones; rules left out are removed. Nothing is ever lost: entries are calculated from the activity log, so changes apply **retroactively** (a removed rule stops counting; add it back and it counts again).

**Before saving a rule change, call `/preview`** with the same body and show the impact:
```jsonc
{ "becomeEligible": 0, "becomeIneligible": 12, "entriesBefore": 940, "entriesAfter": 812,
  "changed": [ { "personId": 7, "discord": "sam", "instagram": "sam_ig",
                 "before": { "eligible": true, "entries": 3 }, "after": { "eligible": false, "entries": 0 } } ] }
```
To keep people who'd lose out ("grandfather" them), add a `requirement_met` override for each (see People).

**Delete is permanent:** removes the giveaway and everything in it. `409` if it's open (close first). `confirm` must equal the exact name (not needed in test mode); otherwise `400` with `requiresConfirm: true` and the people count, for a "type the name to delete" dialog.

**Only one giveaway at a time:** creating or moving dates so two not-closed giveaways overlap returns `409`.

**Retention:** 90 days after a giveaway ends, its people, activity and entries are deleted (setup, `stats` and winners stay). `personalDataDeletesAt` says when; a heads-up posts in #community-updates 7 days before. Once `personalDataDeletedAt` is set, `/people` is empty: show "removed per privacy policy" and use `stats`. Winners keep who won for a year (`person`), then are anonymized.

---

## People

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/giveaways/:id/people` | — | `Person[]`: everyone with activity, eligible or not, with `missing`, `entries` and `breakdown` |
| POST | `/giveaways/:id/people/:personId/overrides` | see below | `201 Override` |
| DELETE | `/giveaways/:id/overrides/:overrideId` | — | The override, revoked |
| POST | `/giveaways/:id/people/:personId/disqualify` | `{ reason }` | The person |
| POST | `/giveaways/:id/people/:personId/restore` | — | The person |

**Overrides:**
- `{ "kind": "requirement_met", "ruleId": 8, "reason": "Grandfathered" }`: counts a **required** rule as met for this person (after a rule change, or to confirm an `everyone` manual check like a follow).
- `{ "kind": "manual_entry", "label": "Helped run the event", "weight": 2 }`: extra entries.

`Person.overrides` lists the active ones (with `id`, to revoke).

---

## Winners

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/giveaways/:id/winners` | — | `Winner[]` with their person (`entrant`) |
| POST | `/giveaways/:id/winners` | `{ personId }` | `201 Winner` (manual pick) · `409` if open or all slots filled · `400` if not eligible |
| POST | `/giveaways/:id/winners/draw` | — | `201 Winner` (random, weighted by entries) · `409` if nobody's left |
| POST | `/giveaways/:id/winners/:winnerId/checks/:ruleId` | `{ confirmed: boolean }` | Updated `Winner` |
| POST | `/giveaways/:id/winners/:winnerId/notify` | — | Sends the DM now · `503` if the bot is offline |
| POST | `/giveaways/:id/winners/:winnerId/outcome` | `{ outcome: "accepted" \| "declined" }` | Updated `Winner` |

- **Winner checks:** if a required rule is a manual action checked for winners (e.g. "follows @BostonBlerds"), the winner starts in **checking**. Confirm each check (here or with the buttons in #community-updates); when all are confirmed they move on to **pending**. A rejected check declines them.
- **pending:** DM not sent yet (auto notify, after the delay) or waiting for admins to report (manual notify). **notified:** DM sent. **unreachable:** DMs closed or Instagram-only; admins reach out and report.
- **declined / expired:** stays in the history and **all their entries are disqualified**. The slot is refilled: auto-select draws again, manual-select asks admins to pick.
- Winners can only be picked after the giveaway closes. Disqualified people, people who left the server (when Discord `member` is required) and anyone already picked can't be picked.

---

## Instagram

| Method | Path | Returns |
|---|---|---|
| GET | `/instagram/posts?limit=12` | Post picker: `{ id, permalink, caption, mediaType, thumbnailUrl, postedAt, commentsCount }[]`, newest first. Thumbnail URLs expire; don't store them. |
| GET | `/instagram/resolve?url=<link>` | The post for a link (preview before saving), or `404` |
| POST | `/giveaways/:id/sync` | "Sync now": reads comments and tagged posts immediately, returns `{ igSync }` |
| GET | `/instagram/status` | Connection health: `{ configured, expiresAt, refreshedAt, lastAttemptAt, lastError }`. The token renews itself weekly; warn if `lastError` is set or `expiresAt` is under 2 weeks away. |
| POST | `/instagram/renew` | Renew the token now; returns the status |

- **Posts live on comment rules** (`options.post`, required): send the post's link (Reels too; share junk like `?igsh=` is fine) or media ID; responses return the post (`id`, `permalink`, `postedAt`). A link that isn't on @BostonBlerds returns `400`. For a bonus on the promo Reel, add a second comment rule with the Reel's link.
- A rule's post can be set or added any time, even after the start: comments count from `startsAt` by when they were written. A new post triggers an immediate read; posts are re-read every 30 minutes while open and once more after close.
- Deleted or hidden comments, and tagged posts that are deleted or no longer tag us, **stop counting** on the next read.

---

## Exports (CSV)

Calculated on the server, the same way as the dashboard and draws.

| Path | Rows |
|---|---|
| `/giveaways/:id/export/entries.csv` | One row **per entry** (weights expanded), eligible people only: what a random picker loads |
| `/giveaways/:id/export/entrants.csv` | One row **per person**: accounts, form answers, eligible, missing, counts per bonus rule, base/bonus/manual/total |
| `/giveaways/:id/export/activity.csv` | Every recorded action, including removed ones (with why) |
| `/giveaways/:id/export/audit.csv` | Full history |

---

## Example (server-side)

```ts
await fetch('https://api.bostonblerds.com/admin/giveaways', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.SYNAPSE_ADMIN_API_KEY}`,
    'X-Admin-User': session.user.email,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    name: 'GTA VI Giveaway',
    startsAt: '2026-10-19T16:00:00-04:00',
    endsAt: '2026-11-20T22:30:00-05:00',
    baseWeight: 1,
    platforms: [
      { platform: 'discord', settings: { channel: 'gta-giveaway' }, rules: [
        { action: 'enter', type: 'required' },
        { action: 'member', type: 'required' },
      ] },
      { platform: 'instagram', rules: [
        { action: 'follow', type: 'required', check: 'winners' },
        { action: 'comment', type: 'bonus', weight: 1, maxCount: 1, options: { post: 'https://www.instagram.com/p/…', requireTag: true } },
        { action: 'comment', type: 'bonus', weight: 1, maxCount: 1, options: { post: 'https://www.instagram.com/reel/…' } }, // promo Reel
        { action: 'story', type: 'bonus', weight: 1, maxCount: 1 },
        { action: 'story', type: 'bonus', weight: 1, maxCount: 5, windowStart: '2026-11-20T18:00:00-05:00', windowEnd: '2026-11-20T22:30:00-05:00' },
      ] },
    ],
    // The Instagram username field is added and locked automatically.
    formFields: [{ id: 'platform', type: 'select', label: 'What do you play on?', required: true, options: ['PS5', 'Xbox', 'PC'] }],
    winners: { count: 1, select: 'auto', notify: 'auto', claimHours: 12 },
  }),
});
```

---

## v1 compatibility (deprecated)

So the current dashboard keeps working during the move, the API still **accepts** `entryMethods`, `entryChannel`, `igPost` (goes on every comment rule), flat `rules` (`ig_comment` / `ig_story` / `ig_tag`), `ig_username` form fields and the flat winner fields (`winnerCount`, `winnerSelect`, `winnerNotify`, `notifyDelayMinutes`, `winnerMessage`, `claimHours`), and translates them into `platforms` / `winners`. Responses also include the v1 mirrors (`entryMethods`, `entryChannel`, `igMediaId`, `igPermalink`, `igPostedAt`, flat `rules`, flat winner fields), and the v1 routes still work: `GET /entrants`, `POST /bonuses` (= a manual-entry override), `DELETE /bonuses/:id`, `/entrants/:id/disqualify|restore`, `POST /winner`, and `{ entrantId }` when picking. **Breaking:** `winners` is now the grouped settings object (the pick list moved to `winners.history` and `GET /winners`). These will be removed once the dashboard is on v2.

---

## Discord side (for reference)
- Updates post to **#community-updates** (admin-only) per the `announcements` settings. Changing `endsAt` to later, or raising `maxParticipants`, posts an "extended" update.
- **Username conflicts** (a second Discord account entering with an Instagram username someone already used) are flagged there; the second entry isn't saved.
- **[Extend]** on countdown and 99%-capacity updates: admins add hours and/or spots in Discord. A giveaway that filled up or ran out of time reopens; one closed early stays closed.
- Right-click an update → **Apps → Post to giveaway channel** reposts it (without buttons) in the giveaway's entry channel.
- `/admin giveaway timer` posts a live countdown on demand. `/admin` is hidden from members.
- `/giveaway` only exists in the server while a giveaway with a Discord `enter` rule is open.
