# The Giveaway Object

Reference for anyone working with Synapse giveaways: the admin dashboard, scripts, future clients.
Endpoints: [admin-api.md](admin-api.md). Design and reasoning: [giveaway-engine-v2-spec.md](giveaway-engine-v2-spec.md).

> **Status:** live (engine v2). During the move the API also accepts and returns the old v1 fields; see [v1 fields](#v1-fields-deprecated) at the end.

**Conventions**
- **Timestamps** are ISO 8601 with an offset (`2026-11-20T22:30:00-05:00`). Responses use UTC (`…Z`). Show them in Eastern time.
- **Writable** fields can be sent on create (`POST /giveaways`) and edit (`PATCH /giveaways/:id`). On edit, leave a field out to keep it.
- **`null`:** for fields marked *nullable*, `null` clears the value. For the rest, `null` means "use the default" on create and "keep" on edit.
- **Read-only** fields are calculated by Synapse and ignored if sent, so a client can send back exactly what it received.

**Contents:** [Giveaway](#giveaway) · [Platform](#platform) · [Rule](#rule) · [Actions](#actions) · [FormField](#formfield) · [Announcements](#announcements) · [WinnerSettings](#winnersettings) · [Winner](#winner) · [Person](#person) · [Override](#override) · [Preview](#preview-dry-run) · [Stats](#stats) · [InstagramSync](#instagramsync)

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
  "platforms": [
    {
      "platform": "discord",
      "settings": { "channel": "gta-giveaway" },
      "rules": [
        { "id": 10, "action": "enter",  "type": "required", "label": "Discord: entered with /giveaway enter", /* … */ },
        { "id": 11, "action": "member", "type": "required", "label": "Discord: is in the server", /* … */ }
      ]
    },
    {
      "platform": "instagram",
      "settings": { "sync": { /* InstagramSync, read-only */ } },
      "rules": [
        { "id": 19, "action": "follow",  "type": "required", "check": "winners", /* … */ },
        { "id": 7,  "action": "comment", "type": "bonus", "weight": 1, "maxCount": 1,
          "options": { "requireTag": true,
                       "post": { "id": "1789…", "permalink": "https://www.instagram.com/p/…/", "postedAt": "…" } } },
        { "id": 8,  "action": "story",   "type": "bonus", "weight": 1, "maxCount": 1, "options": {} },
        { "id": 9,  "action": "story",   "type": "bonus", "weight": 1, "maxCount": 5, "options": {},
          "windowStart": "2026-11-21T00:00:00.000Z", "windowEnd": "2026-11-21T03:30:00.000Z" }
      ]
    }
  ],
  "formFields": [
    { "id": "ig_username", "type": "account", "platforms": ["instagram"], "label": "Instagram Username", "required": true, "locked": true }
  ],
  "reminderText": "Thanks for joining! Don't forget to follow us on [Instagram](https://www.instagram.com/bostonblerds/)!",
  "maxParticipants": null,
  "testMode": false,
  "announcements": { /* Announcements */ },
  "winners": { /* WinnerSettings */ },
  "closedAt": null,
  "closeReason": null,
  "entrantCount": 42,
  "eligibleCount": 40,
  "entryCount": 97,
  "stats": null,
  "personalDataDeletesAt": null,
  "personalDataDeletedAt": null,
  "createdAt": "…",
  "updatedAt": "…"
}
```

| Field | Type | Writable | Meaning |
|---|---|---|---|
| `id` | integer | — | Unique ID, never reused. |
| `name` | string (1–80) | ✅ required | Display name. Also names export files. |
| `slug` | string | — | URL-safe name made from `name`. |
| `status` | `"scheduled"` \| `"open"` \| `"closed"` | — | Before `startsAt`: scheduled. Then open, until `endsAt`, an early close or the cap. Then closed. |
| `startsAt` | timestamp | ✅ required | When entries open. Nothing before this counts. |
| `endsAt` | timestamp | ✅ required | When entries close. Must be after `startsAt`. |
| `baseWeight` | integer ≥ 1 | ✅ (default `1`) | Entries for being **eligible** (meeting every required rule). Bonuses add to this. |
| `platforms` | `Platform[]` (1–2) | ✅ required | Where the giveaway happens, and its rules. Each platform at most once. |
| `formFields` | `FormField[]` (0–5) | ✅ | The Discord entry form. Only used when Discord has an `enter` rule. Required account fields are added and locked automatically. |
| `reminderText` | string (≤ 500), *nullable* | ✅ | Added to the bot's private "Entry captured!" reply. Discord markdown, including `[text](url)` links. |
| `maxParticipants` | integer ≥ 1, *nullable* | ✅ | Cap on people. Reaching it closes the giveaway. `null` = no cap. |
| `testMode` | boolean | ✅ (default `false`) | Test giveaways post no updates in #community-updates and can be deleted without typing the name. |
| `announcements` | `Announcements` | ✅ | Which updates post in #community-updates. Missing values use the defaults. |
| `winners` | `WinnerSettings` | ✅ | How winners are picked and notified, plus the pick history. |
| `closedAt` | timestamp \| null | — | Set when closed early or by the cap. Ending on time leaves it `null`. |
| `closeReason` | `"early"` \| `"cap"` \| null | — | Why it closed before `endsAt`. |
| `entrantCount` | integer | — | People with any activity, eligible or not, excluding disqualified. |
| `eligibleCount` | integer | — | People who meet every required rule. |
| `entryCount` | integer | — | Total entries across eligible people. |
| `stats` | `Stats` \| null | — | Snapshot of the numbers once closed (refreshed daily). Kept after personal data is deleted. |
| `personalDataDeletesAt` | timestamp \| null | — | When people, activity and entries will be deleted: 90 days after the end. Set once closed. |
| `personalDataDeletedAt` | timestamp \| null | — | Set once they were. Show "removed per privacy policy" and use `stats`. |
| `createdAt`, `updatedAt` | timestamp | — | Bookkeeping. |

**Checked on save** (`400` with a message if not):
- Every platform has at least 1 rule, and every rule's `action` belongs to its platform.
- Discord `enter` needs `settings.channel`.
- Every `comment` rule has a `post`, and it's one of @BostonBlerds' posts.
- `check` is only for `follow`; `post` is only for `comment`.
- Rule windows end after they start, and the giveaway ends after it starts.
- When Discord has `enter` and Instagram is also a platform, the form has a required, locked Instagram account field (added for you if missing).
- At most 5 form fields, unique ids, one Instagram account field.
- Dates don't overlap another giveaway that isn't closed (`409`). Only one runs at a time.

---

## Platform

Each entry in `platforms` is one of these, told apart by `platform`:

```jsonc
{ "platform": "discord",   "settings": { "channel": "gta-giveaway" }, "rules": [ /* Rule */ ] }
{ "platform": "instagram", "settings": { "sync": { /* read-only */ } }, "rules": [ /* Rule */ ] }
```

| Field | Type | Meaning |
|---|---|---|
| `platform` | `"discord"` \| `"instagram"` | Which platform. |
| `settings` | object | Below. |
| `rules` | `Rule[]` (1+) | What counts on this platform. |

**Discord settings**

| Field | Type | Meaning |
|---|---|---|
| `channel` | string, *nullable* | Channel **name** where `/giveaway enter` works. `#` and capitals are stripped (`#GTA-Giveaway` → `gta-giveaway`). Required when there's an `enter` rule. |

**Instagram settings:** nothing to set. Posts live on comment rules (`options.post`). Responses include `sync` (read-only, see [InstagramSync](#instagramsync)).

---

## Rule

One shape for every rule. Which fields matter depends on `type` and `action`.

```jsonc
{
  "id": 7,
  "giveawayId": 1,
  "position": 3,
  "platform": "instagram",
  "action": "comment",
  "type": "bonus",
  "weight": 1,
  "min": 1,
  "check": null,
  "maxCount": 1,
  "windowStart": null,
  "windowEnd": null,
  "frequency": null,
  "options": {
    "requireTag": true,
    "post": { "id": "1789…", "permalink": "https://www.instagram.com/p/…/", "postedAt": "2026-10-19T20:00:00.000Z" }
  },
  "label": "Instagram: commented on a giveaway post (tagging a friend) (instagram.com/p/…/)",
  "description": "#3 Instagram: commented on a giveaway post (tagging a friend) (instagram.com/p/…/), bonus ×1, max 1",
  "createdAt": "…"
}
```

| Field | Type | Writable | Applies to | Meaning |
|---|---|---|---|---|
| `id` | integer | send back | — | Send it back on edit to keep a rule; leave it out to add one. **Rules left out of an edit are removed.** |
| `action` | string | ✅ | all | What the person does. See [Actions](#actions). |
| `type` | `"required"` \| `"bonus"` | ✅ (default `bonus`) | all | **required**: needed to be eligible; it's part of the base entry. **bonus**: adds `weight` entries per counted action. |
| `weight` | integer ≥ 1 | ✅ (default `1`) | bonus | Entries per counted action. |
| `maxCount` | integer ≥ 1 | ✅ (default `1`) | bonus | Most actions counted per person. |
| `windowStart`, `windowEnd` | timestamp, *nullable* | ✅ | all | Only actions in this window count. Defaults to the giveaway's dates, and never reaches past them. |
| `frequency` | `"day"` \| `"week"`, *nullable* | ✅ | bonus | At most one per day / week (Eastern time; weeks run Monday–Sunday). |
| `check` | `"winners"` \| `"everyone"` | ✅ (default `winners`) | `follow` | **winners**: an admin confirms it for each winner before they're contacted. **everyone**: blocks eligibility until an admin confirms it for that person (an override). |
| `min` | integer ≥ 1 | ✅ (default `1`) | required | Times it must be done. Reserved; dashboards can hide it. |
| `options` | object | ✅ | some actions | See [Actions](#actions). |
| `position` | integer | — | — | Order, from the order you send. |
| `platform`, `giveawayId`, `createdAt` | — | — | — | Bookkeeping. |
| `label` | string | — | — | Short name, e.g. "Instagram: follows @BostonBlerds". Used in `missing` and checks. |
| `description` | string | — | — | Full summary with type, weight, max and window. |

**How actions are counted**
- An action that meets a **required** rule is part of the base entry. It doesn't also earn a bonus.
- Each other action goes to the matching **bonus** rule with the narrowest window that still has room, then list order. When a rule is full, the action falls through to the next match, if any.
- Each comment rule only counts comments on its own post. "Comment on the main post, max 1" plus "comment on the Reel, max 1" gives +2 to someone who comments on both.
- Rule changes apply **retroactively**: entries are recalculated from the activity log every time, so nothing is lost when a rule is removed and added back. Preview a change first with [`/preview`](#preview-dry-run).

**Eligibility:** every required rule on every platform is met, and the person isn't disqualified. With **no required rules** at all, any counted action makes someone eligible (an "either" giveaway).

### Actions

| Platform | `action` | Detected | `options` | Counts when… |
|---|---|---|---|---|
| discord | `enter` | auto | — | They run `/giveaway enter` in the channel and submit the form. Having this rule creates the command and form. |
| discord | `member` | auto | — | They're in the Discord server when entries are counted (dashboard, export, draw). Leaving drops them out. |
| instagram | `follow` | **manual** | — | They follow @BostonBlerds. The bot can't see follows, so an admin confirms it (see `check`). |
| instagram | `comment` | auto | `post` (**required**): the post whose comments count. Send a link (`instagram.com/p/…` or `/reel/…`, share links fine) or a media ID; responses return `{ id, permalink, postedAt }`. `requireTag` (boolean): the comment must @mention someone other than us or the commenter. | They comment on that post. Read live by webhook, re-read every 30 minutes and once more after close. Deleted or hidden comments stop counting. Replies to other comments count too. |
| instagram | `story` | auto | — | They mention @BostonBlerds in their Story. Arrives by webhook, instantly. |
| instagram | `tag` | auto | `captionIncludes` (string): text the caption must contain, any case, e.g. `#BBxGTAVI`. | They post to their feed (photo, carousel or Reel), tag @BostonBlerds with "Tag people", and the post went up during the rule's window. Not Story mentions or caption-only @mentions. Private accounts aren't visible. Deleted or untagged posts stop counting. ⚠️ A public tagged post didn't come through in the Oct 19 rehearsal; under investigation, so don't rely on it yet. |

---

## FormField

The Discord entry form (`/giveaway enter`). Up to 5 fields.

```jsonc
{ "id": "ig_username", "type": "account", "platforms": ["instagram"], "label": "Instagram Username", "required": true, "locked": true, "placeholder": "bostonblerds" }
{ "id": "platform", "type": "select", "label": "What do you play on?", "required": true, "options": ["PS5", "Xbox", "PC"] }
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string (`a-z0-9_`, ≤ 40) | Unique key. Answers are stored under it. |
| `type` | `"account"` \| `"short_text"` \| `"long_text"` \| `"select"` | **account**: their username on another platform. **select**: a dropdown. |
| `platforms` | `["instagram"]` | `account` only: which platform the username is for. |
| `label` | string (≤ 45) | Shown above the field. |
| `required` | boolean (default `false`) | Must be filled in. |
| `placeholder` | string (≤ 100), optional | Hint text. |
| `options` | string[] (1–25) | `select` only: the choices. |
| `locked` | boolean (read-only) | `true` on account fields Synapse requires. Don't let admins remove them. |

Instagram usernames are cleaned up (`@`, links and capitals removed) and checked. One Discord account per Instagram username: a second Discord account trying the same username isn't saved, and an alert posts in #community-updates. Someone already active on Instagram who then enters on Discord with that username is linked into one person.

---

## Announcements

Updates in #community-updates (admin-only). Every field optional; defaults shown.

| Field | Type | Default | Posts… |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch. (`testMode` always silences.) |
| `started` | boolean | `true` | "🎉 … is live!" |
| `closed` | boolean | `true` | "🔒 … is closed", with totals. |
| `extended` | boolean | `true` | When the end time or cap goes up. |
| `milestones` | `{ enabled, every }` | `{ true, 100 }` | "🎯 100 entrants!" every `every` people. |
| `capacity` | `{ enabled, percents }` | `{ true, [50,75,90,95,99] }` | Only with `maxParticipants`. 99% has an [Extend] button. |
| `countdown` | `{ enabled, hours }` | `{ true, [336,72,24,5] }` | Live countdowns at these hours before the end, with [Extend]. |

---

## WinnerSettings

```jsonc
{ "count": 1, "select": "manual", "notify": "manual", "notifyDelayMinutes": 30,
  "message": null, "defaultMessage": "🎉 Congrats {name}! …", "claimHours": 12, "history": [ /* Winner */ ] }
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `count` | integer (1–100) | `1` | How many winners. |
| `select` | `"auto"` \| `"manual"` | `manual` | **auto**: drawn at close, weighted by entries. **manual**: admins pick or draw from the dashboard. |
| `notify` | `"auto"` \| `"manual"` | `manual` | **auto**: the bot DMs them with [Accept] / [Decline]. **manual**: admins reach out and report the outcome. |
| `notifyDelayMinutes` | integer (0–10080) | `30` | Wait before the auto DM. [Notify now] skips it. |
| `message` | string (≤ 1500), *nullable* | `null` (= default) | DM text. Placeholders: `{name}`, `{giveaway}`, `{deadline}`. |
| `defaultMessage` | string (read-only) | — | Show it as the placeholder when `message` is null. |
| `claimHours` | integer (1–720) | `12` | Time to accept. Starts when the DM is sent. |
| `history` | `Winner[]` (read-only) | — | Every pick, in order. Same as `GET /giveaways/:id/winners`. |

Sending the object back with `history` and `defaultMessage` in it is fine; they're ignored.

### Winner

Read-only.

| Field | Type | Meaning |
|---|---|---|
| `id` | integer | |
| `personId` | integer \| null | The winning person. `null` once personal data is deleted. |
| `person` | `{ discordId, discordUsername, igUsername }` \| null | Who won, kept for 1 year after the end, then `null`. |
| `status` | see below | Where they are. |
| `checks` | `{ ruleId, label, confirmed, by?, at? }[]` | Winner checks (e.g. the follow). `confirmed`: `true`, `false` or `null` (waiting). |
| `selectedBy` | string | `"auto"` or `"admin:<email>"`. |
| `entriesAtDraw` | integer | Their entries when picked. |
| `notifyAt`, `notifiedAt`, `claimDeadline`, `respondedAt` | timestamp \| null | Timeline. |
| `outcomeBy` | string \| null | Who reported the outcome (the winner via the DM, or an admin). |

**Statuses**
- **checking**: waiting for an admin to confirm the winner checks (buttons in #community-updates, or the API). A rejected check declines them.
- **pending**: ready. The DM goes out after the delay (auto notify), or admins reach out (manual notify).
- **notified**: DM sent, waiting for [Accept] / [Decline].
- **unreachable**: their DMs are closed, or they have no Discord. Admins reach out and report.
- **accepted**: done.
- **declined** / **expired**: kept in the history. **Their entries are disqualified** and the slot opens again.

---

## Person

From `GET /giveaways/:id/people`: everyone with activity, eligible or not.

```jsonc
{
  "id": 12,
  "discord": { "id": "1234", "username": "alex" },
  "accounts": { "instagram": "alex.plays" },
  "answers": { "platform": "PS5" },
  "eligible": true,
  "missing": [],
  "winnerChecks": ["Instagram: follows @BostonBlerds"],
  "entries": { "base": 1, "bonus": 2, "manual": 0, "total": 3 },
  "breakdown": [
    { "ruleId": 7, "count": 1, "weight": 1, "entries": 1, "label": "Instagram: commented on …", "description": "#3 …" }
  ],
  "requirements": [ { "ruleId": 10, "met": true, "via": "activity", "label": "Discord: entered with /giveaway enter" } ],
  "overrides": [],
  "inServer": true,
  "disqualified": null,
  "activity": [ { "id": 88, "platform": "instagram", "action": "comment", "at": "…", "removed": false } ],
  "createdAt": "…"
}
```

| Field | Meaning |
|---|---|
| `id` | Person ID. Use it for overrides, disqualify and picking a winner. |
| `discord` | `{ id, username }`, or `null` for someone only active on Instagram so far. |
| `accounts` | Usernames per platform, from the form or from their activity. |
| `answers` | Form answers by `FormField.id`. Account fields are in `accounts`, not here. |
| `eligible` | Every required rule met, and not disqualified. |
| `missing` | Labels of required rules not met yet. |
| `winnerChecks` | Labels of checks they'll need if they win (e.g. the follow). Don't block eligibility. |
| `entries` | `base` (`baseWeight` if eligible), `bonus` (counted bonus actions × weight), `manual` (manual entries), `total`. All 0 if not eligible. |
| `breakdown` | Per bonus rule: actions counted, weight, entries. |
| `requirements` | Per required rule: `met`, and `via`: `activity`, `override`, `member` or `winner-check` (`null` if not met). |
| `overrides` | Active [overrides](#override). |
| `inServer` | In the Discord server: `true` / `false`, or `null` if unknown (no Discord account, or the bot is offline). |
| `disqualified` | `{ reason, by, at }`, or `null`. Set by an admin, or automatically when a winner declines or expires. |
| `activity` | Everything recorded for them. `removed` is `false`, or why (e.g. "Comment deleted or hidden"). |

---

## Override

An admin's exception for one person. Add with `POST /giveaways/:id/people/:personId/overrides`; remove with `DELETE /giveaways/:id/overrides/:overrideId`.

| `kind` | Send | Effect |
|---|---|---|
| `requirement_met` | `{ kind, ruleId, reason? }` | Counts a **required** rule as met for this person. For grandfathering after a rule change, or confirming a `check: "everyone"` follow. |
| `manual_entry` | `{ kind, label, weight?, reason? }` | Adds `weight` entries (default 1), e.g. "Helped run the event". |

In a Person: `{ id, kind, ruleId, label, weight, reason, by, at }`.

---

## Preview (dry run)

`POST /giveaways/:id/preview` takes the same body as an edit, saves nothing, and returns the impact. Use it before saving rule changes.

```jsonc
{ "becomeEligible": 0, "becomeIneligible": 12, "entriesBefore": 940, "entriesAfter": 812,
  "changed": [ { "personId": 7, "discord": "sam", "instagram": "sam_ig",
                 "before": { "eligible": true, "entries": 3 }, "after": { "eligible": false, "entries": 0 } } ] }
```

---

## Stats

The numbers once a giveaway closes, refreshed daily. Kept after personal data is deleted, so past giveaways keep their totals.

```jsonc
{ "takenAt": "…", "entrants": 312, "eligible": 280, "entries": 940,
  "byRule": [ { "ruleId": 7, "description": "…", "people": 120, "actions": 140, "entries": 120 } ],
  "byPlatform": { "discord": 300, "instagram": 260 } }
```

| Field | Meaning |
|---|---|
| `entrants` | Everyone who took part, disqualified included. |
| `eligible`, `entries` | Eligible people and their total entries. |
| `byRule` | Per rule: people who met or earned it, actions counted, entries from it. |
| `byPlatform` | People with activity on each platform. |

---

## InstagramSync

In the Instagram platform's `settings.sync`. Show a warning when `lastError` is set.

```jsonc
{ "lastRunAt": "…", "lastSuccessAt": "…", "lastError": null, "lastReason": "scheduled",
  "lastResult": { "comments": { "posts": 2, "comments": 9, "removed": 1 }, "taggedPosts": { "posts": 0 } } }
```

`lastReason`: `scheduled` (every 30 minutes), `post-set` (a new post was saved), `manual` ("Sync now"), `final` (after close).

---

## v1 fields (deprecated)

Kept so the current dashboard works during the move. They'll be removed once it's on v2.
- **Accepted on write and translated:** `entryMethods`, `entryChannel`, `igPost` (put on every comment rule), flat `rules` with `ig_comment` / `ig_story` / `ig_tag`, `ig_username` form fields, and flat winner fields (`winnerCount`, `winnerSelect`, `winnerNotify`, `notifyDelayMinutes`, `winnerMessage`, `claimHours`). If both are sent, the grouped `winners` object wins.
- **Also in responses:** `entryMethods`, `entryChannel`, `igMediaId`, `igPermalink`, `igPostedAt`, flat `rules`, the flat winner fields, `defaultWinnerMessage`, `discordEntrantCount`, `igSync`.
- **Breaking change:** `winners` used to be the list of picks. It's now the settings object; the picks are in `winners.history`.
