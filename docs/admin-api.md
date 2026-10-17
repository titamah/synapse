# Synapse Admin API — Giveaways

For **admin.bostonblerds.com**. Synapse owns the giveaway data; the dashboard is its UI.

- **Base URL:** `https://api.bostonblerds.com/admin`
- **Auth:** every request sends `Authorization: Bearer <ADMIN_API_KEY>`. The key is a server-side secret: call this API from the dashboard's **server** only, never from the browser.
- **Who's acting:** every change (`POST` / `PATCH` / `DELETE`) must send `X-Admin-User: <signed-in admin's email>`. It's recorded in the audit log.
- **Dates:** ISO 8601 with offset, e.g. `2026-11-20T22:30:00-05:00`. Show them in Eastern time.
- **Errors:** `{ "error": "message" }` with 400 (invalid input), 401 (bad key), 404, or 409 (conflict, e.g. overlapping giveaway).

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
  "entryChannel": "gta-giveaway",                  // Discord channel NAME where /giveaway enter works
  "igHashtag": "#BBxGTAVI",                         // the IG post with this in its caption becomes the giveaway post
  "igMediaId": null, "igPostedAt": null,           // filled in automatically once the post is found
  "formFields": [ /* FormField, max 5 */ ],
  "reminderText": "Don't forget to follow [@BostonBlerds](https://instagram.com/bostonblerds)!",  // Discord markdown, links OK
  "maxParticipants": null,                         // closes automatically when reached
  "announcements": { "enabled": true, "milestoneEvery": 100, "countdownHours": [336, 72, 24, 5] },
  "testMode": false,                               // true = never posts announcements
  "winnerNotify": "manual" | "auto", "claimHours": 12,
  "winnerEntrantId": null, "winnerRecordedBy": null, "winnerRecordedAt": null,
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
  "action": "ig_comment" | "ig_story",
  "maxCount": 5,                 // times it can award an entry to one person
  "windowStart": null, "windowEnd": null,   // optional; default = whole giveaway
  "frequency": null | "day" | "week",       // optional; Eastern time, weeks Mon–Sun
  "options": { "requireTag": true },        // ig_comment only: must @tag a friend
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
| GET | `/giveaways/:id/entrants` | — | `{ entrants: Entrant[], unmatched: Bonus[] }` |
| POST | `/giveaways/:id/bonuses` | `{ entrantId, label }` | `201 Bonus` (manual entry) |
| DELETE | `/giveaways/:id/bonuses/:bonusId` | `{ reason? }` | `Bonus` (removed) |
| POST | `/giveaways/:id/entrants/:entrantId/disqualify` | `{ reason }` | `Entrant` |
| POST | `/giveaways/:id/entrants/:entrantId/restore` | — | `Entrant` |
| POST | `/giveaways/:id/winner` | `{ entrantId }` | `{ winner: Entrant }` |
| GET | `/giveaways/:id/audit` | — | Audit rows, newest first |
| GET | `/giveaways/:id/export/entries.csv` | — | One row **per entry** (for the spinner). Excludes disqualified people and people who left the server. |
| GET | `/giveaways/:id/export/entrants.csv` | — | One row **per person**: form answers, entries per rule, totals |
| GET | `/giveaways/:id/export/audit.csv` | — | Full history |

**Create body:** `name`, `startsAt`, `endsAt`, `formFields`, `rules` are required. Everything else is optional: `entryChannel`, `igHashtag`, `reminderText`, `maxParticipants`, `announcements`, `testMode`, `winnerNotify`, `claimHours`.

**PATCH rules:** send the **full list** in the order you want. Include `id` for existing rules, omit it for new ones; rules you leave out are deleted. Entries already earned under a deleted rule are kept.

**Only one giveaway at a time:** creating or moving dates so two not-closed giveaways overlap returns `409`.

### Entrant (from `/entrants`)
```jsonc
{ "id": 12, "discordId": "1234", "discordUsername": "alex", "igUsername": "alex.plays",
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
