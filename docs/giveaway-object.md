# The Giveaway Object (v2)

Reference for developers working with Synapse giveaways (the admin dashboard, scripts, future clients).
Design and reasoning: [giveaway-engine-v2-spec.md](giveaway-engine-v2-spec.md). Endpoints: [admin-api.md](admin-api.md).

> **Status:** built on branch `feat/engine-v2`; the live server still runs v1 until it's deployed. The v2 API also accepts and returns the v1 fields during the move (see admin-api.md, "v1 compatibility").

**Conventions**
- Timestamps are ISO 8601 strings with an offset (`2026-11-20T22:30:00-05:00`); responses use UTC (`…Z`). Show them in Eastern time.
- **Writable** fields can be sent on create (`POST /giveaways`) and edit (`PATCH /giveaways/:id`). On edit, leave a field out to keep it.
- Optional fields accept `null`. For fields marked *nullable*, `null` clears the value; for the rest, `null` means "use the default / keep."
- **Read-only** fields are computed by Synapse and ignored if sent, so a client can send back what it received.

---

## Giveaway

```jsonc
{
  "id": 1,
  "name": "GTA VI Giveaway",
  "slug": "gta-vi-giveaway",
  "status": "open",
  "startsAt": "2026-10-19T20:00:00.000Z",
  "endsAt": "2026-11-21T03:30:00.000Z",
  "baseWeight": 1,
  "platforms": [ /* Platform */ ],
  "formFields": [ /* FormField */ ],
  "reminderText": "Thanks for joining! Don't forget to follow us on [Instagram](https://www.instagram.com/bostonblerds/)!",
  "maxParticipants": null,
  "testMode": false,
  "announcements": { /* Announcements */ },
  "winners": { /* WinnerSettings */ },
  "closedAt": null,
  "closeReason": null,
  "entrantCount": 0,
  "eligibleCount": 0,
  "entryCount": 0,
  "stats": null,
  "personalDataDeletesAt": null,
  "personalDataDeletedAt": null,
  "createdAt": "…", "updatedAt": "…"
}
```

| Field | Type | Writable | Meaning |
|---|---|---|---|
| `id` | integer | — | Unique ID. Never reused. |
| `name` | string (1–80) | ✅ required | Display name; also names export files. |
| `slug` | string | — | URL-safe name derived from `name`. |
| `status` | `"scheduled"` \| `"open"` \| `"closed"` | — | Derived: before `startsAt` → scheduled; until `endsAt` / closed early / cap reached → open; then closed. |
| `startsAt` | timestamp | ✅ required | When entries open. |
| `endsAt` | timestamp | ✅ required | When entries close. Must be after `startsAt`. |
| `baseWeight` | integer ≥ 1 | ✅ (default `1`) | Entries a person gets for being **eligible** (meeting every required rule). Bonus entries add to this. |
| `platforms` | `Platform[]` (1+) | ✅ required | Where the giveaway happens and its rules. Each platform appears at most once. |
| `formFields` | `FormField[]` (0–5) | ✅ | The Discord entry form. Account fields are added and locked automatically (see FormField). Ignored unless Discord has an `enter` rule. |
| `reminderText` | string (≤ 500), *nullable* | ✅ | Added to the bot's private "Entry captured!" reply. Discord markdown, including `[text](url)` links. |
| `maxParticipants` | integer ≥ 1, *nullable* | ✅ | Cap on people. Reaching it closes the giveaway automatically. `null` = no cap. |
| `testMode` | boolean | ✅ (default `false`) | Test giveaways post no Discord updates and can be deleted without typing the name. |
| `announcements` | `Announcements` | ✅ | Which updates post in `#community-updates`. Defaults filled in. |
| `winners` | `WinnerSettings` | ✅ | How winners are picked and notified. |
| `closedAt` | timestamp \| null | — | Set when closed early or by the cap. (Time-based closes leave it `null`; see `status`.) |
| `closeReason` | `"early"` \| `"cap"` \| null | — | Why it closed before `endsAt`. |
| `entrantCount` | integer | — | People with any activity (eligible or not, excluding disqualified). |
| `eligibleCount` | integer | — | People who meet every required rule. |
| `entryCount` | integer | — | Total entries across eligible people (base + bonuses × weights). |
| `stats` | `Stats` \| null | — | Snapshot taken at close (refreshed daily until personal data is deleted). Kept after personal data is deleted (90 days after the end). |
| `personalDataDeletesAt` | timestamp \| null | — | When people, activity and entries will be deleted (90 days after the end). Set once closed. |
| `personalDataDeletedAt` | timestamp \| null | — | Set once they were. The dashboard shows "removed per privacy policy" and uses `stats`. |
| `createdAt`, `updatedAt` | timestamp | — | Bookkeeping. |

**Rules the API enforces on save:** every platform has at least 1 rule; when Discord has `enter` required and another platform is present, the form has a required account field for that platform; rule windows end after they start; dates don't overlap another open or scheduled giveaway (one at a time).

---

## Platform

A **discriminated union** on `platform`. Each kind has its own `settings` and allowed `actions`.

```jsonc
{ "platform": "discord",   "settings": { /* DiscordSettings */ },   "rules": [ /* Rule */ ] }
{ "platform": "instagram", "settings": { /* InstagramSettings */ }, "rules": [ /* Rule */ ] }
```

| Field | Type | Meaning |
|---|---|---|
| `platform` | `"discord"` \| `"instagram"` | Which platform. *(Future: `"posh"`, `"tiktok"`.)* |
| `settings` | object | Platform-specific, below. |
| `rules` | `Rule[]` (1+) | What counts on this platform. |

### DiscordSettings
| Field | Type | Meaning |
|---|---|---|
| `channel` | string, *nullable* | Channel **name** where `/giveaway enter` works (`#` and capitals are stripped). Required when there's an `enter` rule; `null` otherwise. |

### InstagramSettings
| Field | Type | Meaning |
|---|---|---|
| `sync` | `InstagramSync` (read-only) | Last comment/tag read: `lastRunAt`, `lastSuccessAt`, `lastError` (show a warning if set), `lastResult`. |

Nothing to set here: posts live on the comment rules (`options.post`).

`InstagramPost` (read): `{ "id", "permalink", "postedAt" }` (thumbnails expire, so get them from `GET /instagram/posts`). On write, send a link (`https://www.instagram.com/p/…`, Reels included) or a media ID.

---

## Rule

One shape for every rule. Which fields apply depends on `type` and `action`.

```jsonc
{
  "id": 9,
  "action": "story",
  "type": "bonus",
  "weight": 1,
  "maxCount": 5,
  "windowStart": "2026-11-20T19:00:00-05:00",
  "windowEnd": "2026-11-20T22:30:00-05:00",
  "frequency": null,
  "options": {},
  "description": "Instagram Story mention (bonus ×1, max 5, Nov 20 7:00–10:30 PM)"
}
```

| Field | Type | Applies to | Meaning |
|---|---|---|---|
| `id` | integer | — | Send it back on edit to update a rule in place; omit to add a new one. Rules left out of an edit are removed. |
| `action` | string (table below) | all | What the person does. Must belong to the rule's platform. |
| `type` | `"required"` \| `"bonus"` | all | **required**: needed to be eligible (part of the base entry). **bonus**: adds `weight` entries per counted action. |
| `min` | integer ≥ 1 (default 1) | required | Times it must be done. Reserved; dashboards can hide it. |
| `check` | `"winners"` \| `"everyone"` (default `winners`) | manual actions | **winners**: an admin confirms it for the winner before the DM is sent. **everyone**: confirmed per person in the dashboard; blocks eligibility until then. |
| `weight` | integer ≥ 1 (default 1) | bonus | Entries per counted action. |
| `maxCount` | integer ≥ 1 | bonus | Max counted per person. |
| `windowStart`, `windowEnd` | timestamp, *nullable* | all | Only actions in this window count. Defaults to the giveaway's dates and never extends past them. |
| `frequency` | `"day"` \| `"week"`, *nullable* | bonus | At most once per day / week (Eastern; weeks run Mon–Sun). |
| `options` | object | some actions | See the actions table. |
| `description` | string | — | Read-only, human-readable summary. |

**Counting:** an action that satisfies a required rule is part of the base entry and doesn't also earn a bonus. Bonus actions go to the most specific matching rule (narrowest window) that still has room, then list order. Each comment rule counts comments on its own post, so "comment on the main post, max 1" plus "comment on the Reel, max 1" gives +2 to someone who comments on both.

### Actions
| Platform | `action` | Detected | `options` | Meaning |
|---|---|---|---|---|
| discord | `enter` | auto | — | Ran `/giveaway enter` and submitted the form. Creates the form and command. |
| discord | `member` | auto | — | Is in the server when entries are counted (dashboard, export, draw). |
| instagram | `follow` | **manual** | — | Follows @BostonBlerds. The bot can't see follows; an admin confirms (`check`). |
| instagram | `comment` | auto | `post` (**required**: the post whose comments count; write a link or media ID, read an `InstagramPost`); `requireTag: boolean` (must @mention someone other than us or the commenter) | Commented on that post. Deleted or hidden comments stop counting. |
| instagram | `story` | auto | — | Mentioned @BostonBlerds in their Story (from `startsAt`; no post needed). |
| instagram | `tag` | auto | `captionIncludes: string` (case-insensitive text the caption must contain, e.g. a hashtag) | Posted to their feed (photo, carousel or Reel) and tagged @BostonBlerds with "Tag people", during the rule's window (by when the post went up). Not Story mentions (`story`) or caption-only @mentions. Private accounts can't be seen. Deleted or untagged posts stop counting. |

**Eligibility:** a person is eligible when every **required** rule on every platform is met and they aren't disqualified. If the giveaway has **no required rules**, any counted action makes them eligible (an "OR" giveaway).

---

## FormField

The Discord entry form (`/giveaway enter`). Up to 5 fields in total.

```jsonc
{ "id": "ig", "type": "account", "platforms": ["instagram"], "label": "Instagram username", "required": true, "locked": true }
{ "id": "platform", "type": "select", "label": "What do you play on?", "required": true, "options": ["PS5", "Xbox", "PC"] }
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string (`a-z0-9_`, ≤ 40) | Unique key; answers are stored under it. |
| `type` | `"account"` \| `"short_text"` \| `"long_text"` \| `"select"` | **account**: a username on another platform (one platform = text box; several = dropdown + text box). **select**: a dropdown. |
| `platforms` | `("instagram")[]` | account only: which platform(s) the username is for. |
| `label` | string (≤ 45) | Shown above the field. |
| `required` | boolean | Must be filled in. |
| `placeholder` | string (≤ 100), optional | Hint text. |
| `options` | string[] (1–25) | select only: the choices. |
| `locked` | boolean (read-only) | `true` for account fields Synapse requires; clients shouldn't let them be removed. |

Usernames are normalized (`@`, links and capitals stripped) and validated. One Discord account per username; a second claim is flagged in `#community-updates`.

---

## Announcements

Discord updates in `#community-updates` (admin-only). Every field is optional; defaults shown.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch. (`testMode` always silences.) |
| `started` | boolean | `true` | "🎉 … is live!" |
| `closed` | boolean | `true` | "🔒 … is closed" |
| `extended` | boolean | `true` | Posted when the end time or cap goes up. |
| `milestones` | `{ enabled: boolean, every: integer }` | `{ true, 100 }` | "🎯 100 entrants!" |
| `capacity` | `{ enabled: boolean, percents: integer[] }` | `{ true, [50,75,90,95,99] }` | Only with `maxParticipants`. 99% includes an [Extend] button. |
| `countdown` | `{ enabled: boolean, hours: number[] }` | `{ true, [336,72,24,5] }` | Live countdowns with [Extend]. |

---

## WinnerSettings

| Field | Type | Default | Meaning |
|---|---|---|---|
| `count` | integer (1–100) | `1` | How many winners. |
| `select` | `"auto"` \| `"manual"` | `manual` | **auto**: drawn at close, weighted by entries. **manual**: admins pick (or draw) from the dashboard. |
| `notify` | `"auto"` \| `"manual"` | `manual` | **auto**: DM with [Accept]/[Decline]. **manual**: admins reach out and report the outcome. |
| `notifyDelayMinutes` | integer (0–10080) | `30` | Wait before the auto DM; [Notify now] skips it. |
| `message` | string (≤ 1500), *nullable* | default text | DM text. Placeholders: `{name}`, `{giveaway}`, `{deadline}`. |
| `defaultMessage` | string (read-only) | — | Shown as the placeholder when `message` is null. |
| `claimHours` | integer (1–720) | `12` | Claim window; starts when the DM is sent. |
| `history` | `Winner[]` (read-only) | — | Every pick, in order (also at `GET /giveaways/:id/winners`). |

### Winner (read-only)
| Field | Type | Meaning |
|---|---|---|
| `id` | integer | |
| `personId` | integer \| null | The winning person (`null` once personal data is deleted). |
| `person` | `{ discordId, discordUsername, igUsername }` \| null | Who won, kept for 1 year after the end, then `null` (anonymized). |
| `status` | `"pending"` \| `"checking"` \| `"notified"` \| `"unreachable"` \| `"accepted"` \| `"declined"` \| `"expired"` | **checking**: waiting on manual winner checks. **unreachable**: DMs closed or Instagram-only; admins reach out. **declined / expired**: entries disqualified, slot refilled. |
| `checks` | `{ ruleId, label, confirmed: boolean \| null }[]` | Manual winner checks and their state. |
| `selectedBy` | string | `"auto"` or the admin. |
| `entriesAtDraw` | integer | Their entries when picked. |
| `notifyAt`, `notifiedAt`, `claimDeadline`, `respondedAt` | timestamp \| null | Timeline. |

---

## Person (from `GET /giveaways/:id/people`)

```jsonc
{
  "id": 12,
  "discord": { "id": "1234", "username": "alex" },     // null = never entered on Discord
  "accounts": { "instagram": "alex.plays" },
  "answers": { "platform": "PS5" },
  "eligible": true,
  "missing": [],                                         // e.g. ["Discord: enter", "Instagram: follow (everyone)"]
  "entries": { "base": 1, "bonus": 3, "total": 4 },
  "breakdown": [ { "ruleId": 7, "description": "…", "count": 1, "weight": 1, "entries": 1 } ],
  "overrides": [ { "ruleId": 8, "by": "admin:you@…", "reason": "Grandfathered" } ],
  "disqualified": null,                                  // or { "reason", "by", "at" }
  "createdAt": "…"
}
```

| Field | Meaning |
|---|---|
| `discord` | Discord identity, or `null` for someone only active on Instagram (so far). |
| `accounts` | Usernames per platform, from the form or detected activity. |
| `answers` | Form answers keyed by `FormField.id` (account fields live in `accounts`). |
| `eligible` / `missing` | Whether every required rule is met, and which aren't yet. |
| `entries` | `base` = `baseWeight` if eligible (else 0); `bonus` = Σ counted bonus actions × weight; `total`. Disqualified = 0. |
| `breakdown` | Per rule: how many actions counted, the weight, and the entries they're worth. |
| `overrides` | Requirements an admin marked as met for this person. |
| `disqualified` | Set by an admin, or automatically when a winner declines or expires. |

---

## Stats (snapshot at close)

```jsonc
{ "takenAt": "…", "entrants": 312, "eligible": 280, "entries": 940,
  "byRule": [ { "ruleId": 7, "description": "…", "people": 120, "actions": 140, "entries": 120 } ],
  "byPlatform": { "discord": 300, "instagram": 260 } }
```
Survives the 90-day deletion of personal data, so past giveaways keep their numbers.
