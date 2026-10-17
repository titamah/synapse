# Synapse Admin API — Giveaways

For **admin.bostonblerds.com**. Synapse owns the giveaway data; the dashboard is its UI.

- **Base URL:** `https://api.bostonblerds.com/admin`
- **Auth:** every request sends `Authorization: Bearer <ADMIN_API_KEY>`. The key is a server-side secret: call this API from the dashboard's **server** only, never from the browser.
- **Who's acting:** every change (`POST` / `PATCH` / `DELETE`) must send `X-Admin-User: <signed-in admin's email>`. It's recorded in the audit log.
- **Dates:** ISO 8601 with offset, e.g. `2026-11-20T22:30:00-05:00`. Show them in Eastern time.
- **Errors:** `{ "error": "message" }` with 400 (invalid input), 401 (bad key), 404, or 409 (conflict, e.g. overlapping giveaway).
- **Optional fields** can be left out **or sent as `null`**. For `igPost`, `entryChannel`, `reminderText`, `maxParticipants`, and a rule's `windowStart` / `windowEnd` / `frequency`, `null` **clears** the value. For everything else, `null` means "not set": the default on create, unchanged on edit. Extra fields (e.g. `status`, `description`, `entrantCount`) are ignored, so you can send back what you received.

---

## Giveaway object

```jsonc
{
  "id": 2,
  "name": "GTA VI Giveaway",
  "slug": "gta-vi-giveaway",
  "status": "scheduled" | "open" | "closed",      // derived from dates + closedAt
  "startsAt": "2026-10-19T04:00:00.000Z",
  "endsAt": "2026-11-21T03:30:00.000Z",
  "closedAt": null, "closeReason": null | "cap" | "early",
  "entryMethods": ["discord", "instagram"],        // one or more (a multi-select). More platforms may be added later.
    // discord: /giveaway enter (1 base entry) · instagram: your first counted Instagram action enters you
    // Only instagram → no Discord needed and /giveaway is hidden · both → linked by IG username if someone does both
  "entryChannel": "gta-giveaway",                  // Discord channel NAME where /giveaway enter works
  "igMediaId": "18114618824037715",               // the giveaway's Instagram post (set via igPost)
  "igPermalink": "https://www.instagram.com/p/…/",
  "igPostedAt": "2026-10-19T16:00:00.000Z",
  "igSync": {                                       // last comment read; null if none yet
    "lastRunAt": "…", "lastSuccessAt": "…", "lastReason": "scheduled" | "post-set" | "final" | "manual",
    "lastError": null,                              // a message here = Instagram isn't working (e.g. token expired). Show a warning.
    "lastResult": {
      "comments": { "comments": 42, "hidden": 1, "removed": 1, "awarded": 3, "duplicate": 38 } | null,   // null = no post set
      "taggedPosts": { "posts": 5, "removed": 0, "awarded": 2, "no-rule": 3 } | null                    // null = no tagged-post rule
    }
  },
  "formFields": [ /* FormField, max 5 */ ],
  "reminderText": "Don't forget to follow [@BostonBlerds](https://instagram.com/bostonblerds)!",  // Discord markdown, links OK
  "maxParticipants": null,                         // closes automatically when reached
  "announcements": {                               // Discord updates in #community-updates (defaults shown)
    "enabled": true,                               // master switch
    "started": true, "closed": true, "extended": true,
    "milestones": { "enabled": true, "every": 100 },               // "🎯 100 entrants!"
    "capacity":   { "enabled": true, "percents": [50, 75, 90, 95, 99] },   // only with maxParticipants; 99% includes [Extend]
    "countdown":  { "enabled": true, "hours": [336, 72, 24, 5] }   // live countdown + [Extend]
  },
  "testMode": false,                               // true = never posts updates, and can be deleted without confirming
  "winnerCount": 1,
  "winnerSelect": "auto" | "manual",              // auto = bot draws at close (weighted by entries); manual = admins pick
  "winnerNotify": "auto" | "manual",              // auto = DM with Accept/Decline; manual = admins reach out and report
  "notifyDelayMinutes": 30,                        // auto notify waits this long after a pick ([Notify now] skips it)
  "winnerMessage": null,                           // DM text with {name}, {giveaway}, {deadline}; null = default
  "defaultWinnerMessage": "🎉 Congrats {name}! …", // read-only, for the dashboard's placeholder
  "claimHours": 12,                                // claim window, starts when the DM is sent
  "winners": [ /* Winner, in pick order */ ],
  "entrantCount": 0,
  "rules": [ /* Rule, with a readable "description" */ ]
}
```

### FormField
```jsonc
{ "id": "platform", "label": "What do you play on?", "type": "select", "required": true,
  "placeholder": "Pick one", "options": ["PS5", "Xbox", "PC"] }
```
- `type`: `ig_username` | `short_text` | `long_text` | `select` (needs 1–25 `options`)
- `id`: lowercase letters, numbers, `_`; unique per giveaway. `label`: max 45 characters.
- At most one `ig_username` field. It's **required** whenever there's an Instagram rule.

### Rule ("+ Add rule")
```jsonc
{ "id": 7,                       // omit when adding a new rule
  "action": "ig_comment" | "ig_story" | "ig_tag",   // ig_tag = someone's post that tags @BostonBlerds
  "maxCount": 5,                 // times it can award an entry to one person
  "windowStart": null, "windowEnd": null,   // optional; default = whole giveaway
  "frequency": null | "day" | "week",       // optional; Eastern time, weeks Mon–Sun
  "options": { "requireTag": true,          // ig_comment: must @tag a friend
               "captionIncludes": "#BBxGTAVI" },  // ig_tag: caption must contain this text
  "description": "#1 Instagram comment (max 1, must tag a friend)"  // read-only
}
```
An action counts under the **most specific** rule (narrowest window) that still has room, then list order. Rules with Instagram actions require `igHashtag`.

---

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/giveaways` | — | `Giveaway[]` (newest first) |
| POST | `/giveaways` | Create body (below) | `201 Giveaway` · `409` if dates overlap another giveaway |
| GET | `/giveaways/:id` | — | `Giveaway` |
| PATCH | `/giveaways/:id` | Any create fields | `Giveaway` |
| POST | `/giveaways/:id/close` | — | `Giveaway` (closes early) |
| DELETE | `/giveaways/:id?confirm=<name>` | — | `{ deleted, id, name, entrants }`. **Permanent:** removes the giveaway and all its entrants, entries, rules and history. `409` if it's open (close it first). `confirm` must equal the giveaway's exact name (not needed for test-mode giveaways), otherwise `400` with `requiresConfirm: true` and the entrant count, for a "type the name to delete" dialog. |
| GET | `/giveaways/:id/entrants` | — | `{ entrants: Entrant[], unmatched: Bonus[] }` |
| POST | `/giveaways/:id/bonuses` | `{ entrantId, label }` | `201 Bonus` (manual entry) |
| DELETE | `/giveaways/:id/bonuses/:bonusId` | `{ reason? }` | `Bonus` (removed) |
| POST | `/giveaways/:id/entrants/:entrantId/disqualify` | `{ reason }` | `Entrant` |
| POST | `/giveaways/:id/entrants/:entrantId/restore` | — | `Entrant` |
| GET | `/giveaways/:id/audit` | — | Audit rows, newest first |
| GET | `/giveaways/:id/export/entries.csv` | — | One row **per entry** (for the spinner). Excludes disqualified people and people who left the server. |
| GET | `/giveaways/:id/export/entrants.csv` | — | One row **per person**: form answers, entries per rule, totals |
| GET | `/giveaways/:id/export/audit.csv` | — | Full history |

### Instagram post
Set the giveaway's post with **`igPost`** on create or edit: a post link (`https://www.instagram.com/p/…`, Reels too, share junk like `?igsh=` is fine) or a media ID. `null` clears it.
- It can be set **any time, even after the giveaway starts**. Comments count from `startsAt` based on when each was written, so the first-minute rush still counts.
- Saving a post triggers an immediate comment read. Comments are also re-read every 30 minutes while open, and once more when the giveaway closes.
- Comments that get **deleted or hidden lose their entry** on the next read.
- A link that isn't on @BostonBlerds returns `400` with a clear message.

| Method | Path | Returns |
|---|---|---|
| GET | `/instagram/posts?limit=12` | Post picker: `{ id, permalink, caption, mediaType, thumbnailUrl, postedAt, commentsCount }[]`, newest first. Thumbnail URLs expire after a while; don't store them. |
| GET | `/instagram/resolve?url=<link>` | The post for a link (preview before saving), or `404` |
| POST | `/giveaways/:id/sync` | "Sync now": reads comments immediately, returns `{ igSync }` |
| GET | `/instagram/status` | Instagram connection health: `{ configured, expiresAt, refreshedAt, lastAttemptAt, lastError }`. The token renews itself weekly; warn if `lastError` is set or `expiresAt` is under 2 weeks away. |
| POST | `/instagram/renew` | Renew the token now; returns the status |

### Winners
```jsonc
{ "id": 3, "entrantId": 12, "selectedBy": "auto" | "admin:you@…",
  "status": "pending" | "notified" | "unreachable" | "accepted" | "declined" | "expired",
  "entriesAtDraw": 3, "notifyAt": "…", "notifiedAt": "…", "claimDeadline": "…", "respondedAt": "…", "outcomeBy": "…" }
```
- **Instagram-only winners** can't be DMed, so they go straight to **unreachable** and admins reach out on Instagram.
- **pending:** picked, DM not sent yet (auto notify) or waiting for admins to report (manual notify).
- **notified:** DM sent; **unreachable:** their DMs are closed, so admins reach out and report.
- **declined / expired:** stays in the history, and **all their entries are disqualified**. The slot is refilled: auto-select draws again (with the notify delay), manual-select asks admins to pick.
- Winners can only be picked after the giveaway closes. Disqualified people, people who left the server, and anyone already picked can't be picked.
- Everything is also posted in #community-updates, with buttons: [Notify now], or [Accepted] / [Declined].

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/giveaways/:id/winners` | — | Winners with their `entrant` |
| POST | `/giveaways/:id/winners` | `{ entrantId }` | `201 Winner` (manual pick) · `409` if open or all slots filled · `400` if not eligible |
| POST | `/giveaways/:id/winners/draw` | — | `201 Winner` (random, weighted by entries) · `409` if nobody's left |
| POST | `/giveaways/:id/winners/:winnerId/notify` | — | Sends the DM now · `503` if the bot is offline |
| POST | `/giveaways/:id/winners/:winnerId/outcome` | `{ outcome: "accepted" \| "declined" }` | Updated `Winner` |

**Create body:** `name`, `startsAt`, `endsAt` are required. `formFields` and `rules` default to empty. Everything else is optional: `entryMethods` (default `["discord"]`), `igPost`, `entryChannel`, `winnerCount`, `winnerSelect`, `notifyDelayMinutes`, `winnerMessage`, `reminderText`, `maxParticipants`, `announcements`, `testMode`, `winnerNotify`, `claimHours`.

**PATCH rules:** send the **full list** in the order you want. Include `id` for existing rules, omit it for new ones; rules you leave out are deleted. Entries already earned under a deleted rule are kept.

**Only one giveaway at a time:** creating or moving dates so two not-closed giveaways overlap returns `409`.

**Entries:** a Discord entry is worth 1 base entry; each counted Instagram action adds 1. Instagram-only entrants (no Discord) start at 0, so their first counted action is worth 1.

**Tagged posts** (`ig_tag`) are read every 30 minutes (and on "Sync now"), back to `startsAt`. They don't need `igPost`. A deleted post, or one that no longer tags us, loses its entry.

### Entrant (from `/entrants`)
```jsonc
{ "id": 12, "discordId": "1234", "discordUsername": "alex", "igUsername": "alex.plays",   // discordId/discordUsername null = Instagram-only
  "answers": { "platform": "PS5" },
  "revokedAt": null, "revokedReason": null,        // disqualified if revokedAt is set
  "totalEntries": 3,                               // 1 base + active bonuses; 0 if disqualified
  "inServer": true,                                // still in the Discord (null if unknown)
  "bonuses": [ { "id": 40, "action": "ig_story", "ruleId": 8, "label": null, "createdAt": "…" } ],
  "createdAt": "…" }
```
`unmatched`: Instagram entries from people who haven't run `/giveaway enter` yet. They attach automatically if that IG username enters.

---

## Example (server-side)

```ts
const res = await fetch('https://api.bostonblerds.com/admin/giveaways', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.SYNAPSE_ADMIN_API_KEY}`,
    'X-Admin-User': session.user.email,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    name: 'GTA VI Giveaway',
    startsAt: '2026-10-19T00:00:00-04:00',
    endsAt: '2026-11-20T22:30:00-05:00',
    entryChannel: 'gta-giveaway',
    igHashtag: '#BBxGTAVI',
    formFields: [{ id: 'ig', label: 'Instagram username', type: 'ig_username', required: true }],
    rules: [
      { action: 'ig_story', maxCount: 5, windowStart: '2026-11-20T18:00:00-05:00', windowEnd: '2026-11-20T22:30:00-05:00' },
      { action: 'ig_story', maxCount: 1 },
      { action: 'ig_comment', maxCount: 1, options: { requireTag: true } },
    ],
  }),
});
```

---

## Discord side (for reference)
- Updates post to **#community-updates** (admin-only) per the `announcements` settings. Changing `endsAt` to later, or raising `maxParticipants`, posts an "extended" update.
- **[Extend]** on countdown and 99%-capacity updates: admins add hours and/or spots in Discord. A giveaway that filled up or ran out of time reopens; one closed early stays closed.
- Right-click an update → **Apps → Post to giveaway channel** reposts it (without buttons) in the giveaway's entry channel.
- `/admin giveaway timer` posts a live countdown on demand. `/admin` is hidden from members.
- `/giveaway` only exists in the server while a giveaway is open.
