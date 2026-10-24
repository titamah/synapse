# Giveaway API

How the admin dashboard (admin.bostonblerds.com) talks to Synapse to run giveaways.
**Part 1** explains the requests. **Part 2** describes the objects they send and return.

---

# Using the API

## Basics

- **Base URL:** `https://api.bostonblerds.com/admin`
- **Auth:** every request sends `Authorization: Bearer <ADMIN_API_KEY>`. The key is a server-side secret: call the API from the dashboard's **server**, never from the browser.
- **Who's acting:** every change (`POST`, `PATCH`, `DELETE`) also sends `X-Admin-User: <signed-in admin's email>`. It's saved in the audit log. Without it, changes return `400`.
- **Bodies** are JSON (`Content-Type: application/json`).
- **Timestamps** are ISO 8601 with an offset (`2026-11-20T22:30:00-05:00`). Responses use UTC (`…Z`). Show them in Eastern time.
- **`null`:** for fields marked *nullable*, `null` clears the value. For other optional fields, `null` means "use the default" on create and "keep" on edit. Leaving a field out of an edit keeps it.
- **Read-only fields** in what you send are ignored, so you can send back exactly what you received.
- **Errors** return `{ "error": "message" }` with:

| Status | Meaning |
|---|---|
| `400` | Invalid input. The message says what to fix. |
| `401` | Wrong or missing key. |
| `404` | Not found. |
| `409` | Conflict: overlapping dates, wrong state (e.g. picking a winner while open), all winner slots filled. |
| `502` | Instagram didn't respond. |
| `503` | The bot isn't connected to Discord (only for actions that need it). |

```ts
// Example: create a giveaway (server-side)
await fetch('https://api.bostonblerds.com/admin/giveaways', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.SYNAPSE_ADMIN_API_KEY}`,
    'X-Admin-User': session.user.email,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(giveaway),
});
```

## All endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| **Giveaways** | | | |
| GET | `/giveaways` | — | `Giveaway[]`, newest first |
| POST | `/giveaways` | Giveaway fields | `201 Giveaway` |
| GET | `/giveaways/:id` | — | `Giveaway` |
| PATCH | `/giveaways/:id` | Any Giveaway fields | `Giveaway` |
| POST | `/giveaways/:id/preview` | Same as PATCH | `Preview` (nothing saved) |
| POST | `/giveaways/:id/close` | — | `Giveaway` |
| DELETE | `/giveaways/:id?confirm=<name>` | — | `{ deleted, id, name, entrants }` |
| GET | `/giveaways/:id/audit` | — | Audit rows, newest first |
| **People** | | | |
| GET | `/giveaways/:id/people` | — | `Person[]` |
| POST | `/giveaways/:id/people/:personId/overrides` | `Override` input | `201 Override` |
| DELETE | `/giveaways/:id/overrides/:overrideId` | — | The override, revoked |
| POST | `/giveaways/:id/people/:personId/disqualify` | `{ reason }` | The person |
| POST | `/giveaways/:id/people/:personId/restore` | — | The person |
| **Winners** | | | |
| GET | `/giveaways/:id/winners` | — | `Winner[]`, each with its person (`entrant`) |
| POST | `/giveaways/:id/winners` | `{ personId }` | `201 Winner` |
| POST | `/giveaways/:id/winners/draw` | — | `201 Winner` |
| POST | `/giveaways/:id/winners/:winnerId/checks/:ruleId` | `{ confirmed }` | `Winner` |
| POST | `/giveaways/:id/winners/:winnerId/notify` | — | `{ notified: true }` |
| POST | `/giveaways/:id/winners/:winnerId/outcome` | `{ outcome }` | `Winner` |
| **Instagram** | | | |
| GET | `/instagram/posts?limit=12` | — | Our recent posts (for a post picker) |
| GET | `/instagram/resolve?url=<link>` | — | One post, from a link |
| POST | `/giveaways/:id/sync` | — | `{ igSync }` |
| GET | `/instagram/status` | — | Connection health |
| POST | `/instagram/renew` | — | Connection health, after renewing |
| **Flags** | | | |
| GET | `/flags?giveawayId=6&all=1` | — | `Flag[]`, most severe first. Both query params optional. |
| POST | `/flags/:flagId/snooze` | — | `Flag` (warnings only) |
| POST | `/flags/:flagId/dismiss` | — | `Flag` (info only) |
| **Exports** | | | |
| GET | `/giveaways/:id/export/entries.csv` | — | CSV |
| GET | `/giveaways/:id/export/entrants.csv` | — | CSV |
| GET | `/giveaways/:id/export/activity.csv` | — | CSV |
| GET | `/giveaways/:id/export/audit.csv` | — | CSV |

## Giveaways

### Create

`POST /giveaways` with `name`, `startsAt`, `endsAt` and `platforms` (required). Everything else is optional.

```jsonc
{
  "name": "GTA VI Giveaway",
  "startsAt": "2026-10-19T16:00:00-04:00",
  "endsAt": "2026-11-20T22:30:00-05:00",
  "platforms": [
    { "platform": "discord", "rules": [
      { "action": "enter",  "type": "required", "options": { "channel": "gta-giveaway" } },
      { "action": "member", "type": "required" }
    ] },
    { "platform": "instagram", "rules": [
      { "action": "follow",  "type": "required", "check": "winners" },
      { "action": "comment", "type": "bonus", "maxCount": 1, "options": { "post": "https://www.instagram.com/p/…", "requireTag": true } },
      { "action": "comment", "type": "bonus", "maxCount": 1, "options": { "post": "https://www.instagram.com/reel/…" } },
      { "action": "story",   "type": "bonus", "maxCount": 1 },
      { "action": "story",   "type": "bonus", "maxCount": 5, "windowStart": "2026-11-20T19:00:00-05:00", "windowEnd": "2026-11-20T22:30:00-05:00" }
    ] }
  ],
  "formFields": [ { "id": "platform", "type": "select", "label": "What do you play on?", "required": true, "options": ["PS5", "Xbox", "PC"] } ],
  "winners": { "count": 1, "select": "manual", "notify": "manual" }
}
```

- The Instagram username field is added to the form and locked automatically (Discord entry + Instagram).
- **One giveaway at a time:** dates that overlap another giveaway that isn't closed return `409`.
- Everything checked on save is listed under [Giveaway](#giveaway) in Part 2.

### Edit

`PATCH /giveaways/:id` with only the fields you're changing.

- **Rules:** send each platform's **full rule list** in the order you want. Include `id` for rules you're keeping; leave it out for new ones. **Rules left out are removed.** Easiest: take `platforms` from the GET, change it, send it back.
- **Changes are retroactive.** Entries are recalculated from everything people have done, so a new rule counts past actions, and a removed rule stops counting (add it back and it counts again).
- Moving `endsAt` later or raising `maxParticipants` posts an "extended" update in #community-updates.

### Preview a change first

`POST /giveaways/:id/preview` takes the same body as PATCH, saves nothing, and returns who'd gain or lose eligibility and how entries change ([Preview](#preview)). Show it as a confirmation before saving rule changes. To protect people who'd lose out, give them a `requirement_met` [override](#override) after saving.

### Close early

`POST /giveaways/:id/close` closes it now. `409` if already closed. It also runs a final Instagram read.

### Delete

`DELETE /giveaways/:id?confirm=<exact giveaway name>` permanently removes the giveaway and everything in it.
- Open giveaways can't be deleted (`409`); close first.
- Without the right `confirm`, it returns `400` with `requiresConfirm: true` and the people count, for a "type the name to delete" dialog. Test-mode giveaways skip this.

### Privacy and retention

90 days after a giveaway ends, its people, activity and entries are deleted automatically. The setup, `stats` and winners stay. `personalDataDeletesAt` says when, and a heads-up posts in #community-updates 7 days before. Once `personalDataDeletedAt` is set, `/people` is empty: show "removed per privacy policy" and use `stats`. Winners keep who won for a year, then that's cleared too.

## People

`GET /giveaways/:id/people` returns everyone with activity, eligible or not: entries, what they're missing, and a per-rule breakdown ([Person](#person)). Entries are calculated on every request, so they always reflect the current rules.

- **Disqualify:** `POST …/people/:personId/disqualify` with `{ "reason": "Alt account" }` (reason required). Their entries become 0. **Restore** undoes it.
- **Overrides** are exceptions for one person ([Override](#override)):
  - `{ "kind": "requirement_met", "ruleId": 8, "reason": "Grandfathered" }` counts a required rule as met.
  - `{ "kind": "manual_entry", "label": "Helped run the event", "weight": 2 }` adds entries.
  - Remove one with `DELETE /giveaways/:id/overrides/:overrideId`.

## Winners

Winners can only be picked **after the giveaway closes**.

1. **Pick:** `POST …/winners` with `{ "personId": 12 }`, or **draw** at random weighted by entries with `POST …/winners/draw`. With `winners.select: "auto"`, Synapse draws at close by itself. Returns `409` if all slots are filled and `400` if that person can't win (not eligible, disqualified, or already picked).
2. **Winner checks:** if a required rule is checked for winners (e.g. "follows @BostonBlerds"), the winner starts in `checking`. Confirm each with `POST …/winners/:winnerId/checks/:ruleId` and `{ "confirmed": true }`, or with the buttons in #community-updates. When all are confirmed they move to `pending`; a `false` declines them.
3. **Notify:** with `notify: "auto"`, the DM goes out after `notifyDelayMinutes`. `POST …/notify` sends it now (`503` if the bot is offline). With `notify: "manual"`, admins reach out themselves.
4. **Outcome:** the winner presses Accept/Decline in the DM, or an admin reports it with `POST …/outcome` and `{ "outcome": "accepted" }` or `"declined"`.

A declined or expired winner stays in the history, **all their entries are disqualified**, and the slot opens again. Auto-select draws again; manual asks admins to pick. Everything also posts in #community-updates with buttons.

## Instagram

- **Posts live on comment rules.** Each `comment` rule takes `options.post`: a post link (`instagram.com/p/…` or `/reel/…`; share links with `?igsh=` are fine) or a media ID. Links that aren't @BostonBlerds posts return `400`. For a bonus on another post (like a promo Reel), add another comment rule with that link. The post can be `null` until it's up (e.g. on a scheduled giveaway): the rule counts nothing until a post is set, and when one is, comments from `startsAt` on are read back.
- **Post picker:** `GET /instagram/posts?limit=12` lists our recent posts, newest first: `{ id, permalink, caption, mediaType, thumbnailUrl, postedAt, commentsCount }`. Thumbnail URLs expire, so don't store them. `GET /instagram/resolve?url=<link>` previews one post (`404` if not found).
- **When things are read:** comments and Story mentions arrive instantly by webhook. Comments and tagged posts are also re-read every 30 minutes while open, right away when a new post is saved, and once more after close. Deleted or hidden comments, and deleted or untagged posts, stop counting on the next read. A post can be added any time; comments still count from `startsAt`.
- **Sync now:** `POST /giveaways/:id/sync` reads immediately and returns the result ([InstagramSync](#instagramsync)). Show a warning if `lastError` is set.
- **Connection:** `GET /instagram/status` returns `{ configured, expiresAt, refreshedAt, lastAttemptAt, lastError }`. The token renews itself weekly. Warn if `lastError` is set or `expiresAt` is under 2 weeks away. `POST /instagram/renew` renews now.

## Flags

Flags are things that need an admin's attention. Synapse works them out from the current state every time, so **a flag clears itself as soon as what it checks is fixed**. Show them on the dashboard from `GET /flags`, or from each giveaway's `flags`.

| Level | Meaning | Besides fixing it |
|---|---|---|
| `blocking` | Something isn't working on a live giveaway. | Nothing: it stays until fixed. |
| `warning` | Needs attention soon. | **Snooze** for 24 hours. It comes back if still true. |
| `info` | A heads-up. | **Dismiss**. |

| `code` | Level | Raised when… | Clears when… |
|---|---|---|---|
| `comment_post_missing` | `info` while scheduled, `blocking` once open | A comment rule has no post. | A post is set, in the dashboard or with the Discord button. |
| `entry_channel_problem` | `warning` while scheduled, `blocking` once open | An `enter` channel doesn't exist, or BB-Bot can't see or post in it. | The channel is fixed, or the rule's channel is changed. |
| `ig_sync_failing` | `blocking` | Reading Instagram fails on an open giveaway. | The next read succeeds. |
| `ig_story_webhook_off` | `blocking` | An open giveaway has a Story rule, but @BostonBlerds' "messages" webhook is off, so Story mentions can't arrive (checked on each 30-minute read). | The webhook is back on (next read). |
| `ig_comment_webhook_missed` | `warning` | The last scheduled read found comments the webhook never delivered. Comments still count; the reads cover it. | A scheduled read finds none missed. |
| `ig_token` | `warning` | Renewing the Instagram token failed, or it expires within 2 weeks. | It renews. |
| `winner_waiting` | `warning` | A winner is waiting on winner checks, or is unreachable. | An admin confirms the checks or reports the outcome. |
| `username_conflict` | `warning` | Someone couldn't enter because their Instagram username was already used. | Whoever doesn't own it is disqualified. |
| `retention_upcoming` | `info` | Personal data will be deleted within 7 days. | It's deleted, or dismissed. |

**In Discord (#community-updates):**
- **Alerts:** each flag is posted once when it appears, with a **Resolve** button to the dashboard (`ADMIN_DASHBOARD_URL`, e.g. `https://admin.bostonblerds.com/giveaways/6`), plus **Snooze 24h** (warnings) or **Dismiss** (info). When it clears, the alert changes to ✅ Resolved. A missing post on a scheduled giveaway doesn't alert, only once the giveaway opens. Test-mode giveaways never alert. Username conflicts are already alerted when they happen.
- **Daily digest** at midnight Eastern: every open flag in one message. Nothing is posted if there are none.
- **New-post suggestion:** while a giveaway is open and a comment rule has no post, Synapse checks @BostonBlerds' posts every 10 minutes. For each new post (from a day before the start on), BB-Bot asks "Use for Rule #4?" with one button per rule missing a post, plus "Not this one". Choosing a rule sets the post and reads its comments back to the start.

## Exports

CSV files, calculated on the server the same way as the dashboard and draws. File names start with the giveaway's name.

| File | One row per… |
|---|---|
| `entries.csv` | **Entry**, eligible people only, weights expanded: what a random picker loads. |
| `entrants.csv` | Person: accounts, form answers, eligible, missing, counts per bonus rule, base/bonus/manual/total, in server, disqualified reason. |
| `activity.csv` | Recorded action, including removed ones (with why). |
| `audit.csv` | Change in the history: who, what, when. |

## In Discord (for reference)

- Updates post in **#community-updates** (admin-only), per the `announcements` settings.
- **Username conflicts** (a second Discord account entering with an Instagram username someone already used) are flagged there; the second entry isn't saved.
- **[Extend]** on countdown and 99%-capacity updates lets admins add hours or spots from Discord. A giveaway that filled up or ran out of time reopens; one closed early stays closed.
- Right-click an update → **Apps → Post to giveaway channel** reposts it in the giveaway's channel.
- `/admin giveaway timer` posts a live countdown. `/admin` is hidden from members.
- `/giveaway` only exists while a giveaway with a Discord `enter` rule is open, and only works in its enter rules' channels.

---

# Objects

**Contents:** [Giveaway](#giveaway) · [Platform](#platform) · [Rule](#rule) · [Actions](#actions) · [FormField](#formfield) · [Announcements](#announcements) · [WinnerSettings](#winnersettings) · [Winner](#winner) · [Person](#person) · [Override](#override) · [Preview](#preview) · [Stats](#stats) · [InstagramSync](#instagramsync) · [Flag](#flag)

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
| `formFields` | `FormField[]` (0–5) | ✅ | The Discord entry form. Only used when Discord has an `enter` rule. |
| `reminderText` | string (≤ 500), *nullable* | ✅ | Added to the bot's private "Entry captured!" reply. Discord markdown, including `[text](url)` links. |
| `maxParticipants` | integer ≥ 1, *nullable* | ✅ | Cap on people. Reaching it closes the giveaway. `null` = no cap. |
| `testMode` | boolean | ✅ (default `false`) | No updates in #community-updates, and deletable without typing the name. |
| `announcements` | `Announcements` | ✅ | Which updates post in #community-updates. |
| `winners` | `WinnerSettings` | ✅ | How winners are picked and notified, plus the pick history. |
| `closedAt` | timestamp \| null | — | Set when closed early or by the cap. Ending on time leaves it `null`. |
| `closeReason` | `"early"` \| `"cap"` \| null | — | Why it closed before `endsAt`. |
| `entrantCount` | integer | — | People with any activity, excluding disqualified. |
| `eligibleCount` | integer | — | People who meet every required rule. |
| `entryCount` | integer | — | Total entries across eligible people. |
| `stats` | `Stats` \| null | — | The numbers once closed. Kept after personal data is deleted. |
| `personalDataDeletesAt` | timestamp \| null | — | When people and activity will be deleted (90 days after the end). Set once closed. |
| `personalDataDeletedAt` | timestamp \| null | — | Set once they were. |
| `flags` | `Flag[]` | — | This giveaway's current [flags](#flag), including snoozed and dismissed ones (check `open`). |
| `createdAt`, `updatedAt` | timestamp | — | Bookkeeping. |

**Checked on save** (`400` with a message if not):
- Every platform has at least 1 rule, and every rule's `action` belongs to its platform.
- Every `enter` rule has a `channel`, and no two `enter` rules share one.
- A `comment` rule's `post`, when set, is one of @BostonBlerds' posts.
- `check` is only for `follow`; `post` is only for `comment`; `channel` is only for `enter`.
- Rule windows end after they start.
- With Discord `enter` and Instagram both present, the form gets a required, locked Instagram account field (added if missing).
- At most 5 form fields, unique ids, one Instagram account field.
- Dates don't overlap another giveaway that isn't closed (`409`).

## Platform

Each entry in `platforms` is one of these, told apart by `platform`:

```jsonc
{ "platform": "discord",   "settings": {}, "rules": [ /* Rule */ ] }
{ "platform": "instagram", "settings": { "sync": { /* read-only */ } }, "rules": [ /* Rule */ ] }
```

| Field | Type | Meaning |
|---|---|---|
| `platform` | `"discord"` \| `"instagram"` | Which platform. |
| `settings` | object | Nothing to set: what an action needs lives on its rule (`enter` → `channel`, `comment` → `post`). Instagram returns `sync`, read-only ([InstagramSync](#instagramsync)). |
| `rules` | `Rule[]` (1+) | What counts on this platform. |

## Rule

One shape for every rule. Which fields matter depends on `type` and `action`.

```jsonc
{
  "id": 7,
  "position": 3,
  "platform": "instagram",
  "action": "comment",
  "type": "bonus",
  "weight": 1,
  "maxCount": 1,
  "windowStart": null,
  "windowEnd": null,
  "frequency": null,
  "check": null,
  "min": 1,
  "options": {
    "requireTag": true,
    "post": { "id": "1789…", "permalink": "https://www.instagram.com/p/…/", "postedAt": "2026-10-19T20:00:00.000Z" }
  },
  "label": "Instagram: commented on a giveaway post (tagging a friend) (instagram.com/p/…/)",
  "description": "#3 Instagram: commented on a giveaway post (tagging a friend) (instagram.com/p/…/), bonus ×1, max 1",
  "giveawayId": 1,
  "createdAt": "…"
}
```

| Field | Type | Writable | Applies to | Meaning |
|---|---|---|---|---|
| `id` | integer | send back | — | Keeps the rule on edit. Leave out for a new rule. |
| `action` | string | ✅ | all | What the person does. See [Actions](#actions). |
| `type` | `"required"` \| `"bonus"` | ✅ (default `bonus`) | all | **required**: needed to be eligible; part of the base entry. **bonus**: adds `weight` entries per counted action. |
| `weight` | integer ≥ 1 | ✅ (default `1`) | bonus | Entries per counted action. |
| `maxCount` | integer ≥ 1 | ✅ (default `1`) | bonus | Most actions counted per person. |
| `windowStart`, `windowEnd` | timestamp, *nullable* | ✅ | all | Only actions in this window count. Defaults to the giveaway's dates; never reaches past them. |
| `frequency` | `"day"` \| `"week"`, *nullable* | ✅ | bonus | At most one per day / week (Eastern; weeks run Monday–Sunday). |
| `check` | `"winners"` \| `"everyone"` | ✅ (default `winners`) | `follow` | **winners**: confirmed for each winner before they're contacted. **everyone**: blocks eligibility until confirmed for that person (an override). |
| `min` | integer ≥ 1 | ✅ (default `1`) | required | Times it must be done. Reserved; can be hidden. |
| `options` | object | ✅ | some actions | See [Actions](#actions). |
| `position` | integer | — | — | Order, from the order sent. |
| `label` | string | — | — | Short name. Used in `missing` and winner checks. |
| `description` | string | — | — | Full summary: type, weight, max, window. |
| `platform`, `giveawayId`, `createdAt` | — | — | — | Bookkeeping. |

**How actions are counted**
- An action that meets a **required** rule is part of the base entry and doesn't also earn a bonus.
- Each other action goes to the matching **bonus** rule with the narrowest window that still has room, then list order. When a rule is full, the action falls through to the next match.
- Each comment rule only counts comments on its own post. "Comment on the main post, max 1" plus "comment on the Reel, max 1" gives +2 to someone who does both.

**Eligibility:** every required rule on every platform is met, and the person isn't disqualified. With **no required rules** at all, any counted action makes someone eligible (an "either" giveaway).

### Actions

| Platform | `action` | Detected | `options` | Counts when… |
|---|---|---|---|---|
| discord | `enter` | auto | `channel` (**required**): the channel **name** where it counts. `#` and capitals are stripped (`#GTA-Giveaway` → `gta-giveaway`). | They run `/giveaway enter` in that channel and submit the form. A giveaway can have several `enter` rules, one per channel: `/giveaway enter` works in all of them, and each rule counts entries made in its own channel (e.g. required in #gta-giveaway, +1 bonus in #general). Entering again in the same channel just updates their answers. Having an `enter` rule creates the command and form. |
| discord | `member` | auto | — | They're in the Discord server when entries are counted (dashboard, export, draw). |
| instagram | `follow` | **manual** | — | They follow @BostonBlerds. The bot can't see follows; an admin confirms (see `check`). |
| instagram | `comment` | auto | `post`: the post whose comments count. Send a link or media ID; returned as `{ id, permalink, postedAt }`. *Nullable*: until set, the rule counts nothing and its label ends "(no post yet)". `requireTag` (boolean): the comment must @mention someone other than us or the commenter. | They comment (or reply) on that post. Deleted or hidden comments stop counting. |
| instagram | `story` | auto | — | They mention @BostonBlerds in their Story. |
| instagram | `tag` | auto | `captionIncludes` (string): text the caption must contain, any case, e.g. `#BBxGTAVI`. | They post to their feed (photo, carousel or Reel) tagging @BostonBlerds with "Tag people", during the rule's window. Not Story or caption-only mentions. Private accounts aren't visible. Deleted or untagged posts stop counting. ⚠️ A public tagged post didn't come through in testing; don't rely on this yet. |

## FormField

The Discord entry form. Up to 5 fields.

```jsonc
{ "id": "ig_username", "type": "account", "platforms": ["instagram"], "label": "Instagram Username", "required": true, "locked": true, "placeholder": "bostonblerds" }
{ "id": "platform", "type": "select", "label": "What do you play on?", "required": true, "options": ["PS5", "Xbox", "PC"] }
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string (`a-z0-9_`, ≤ 40) | Unique key. Answers are stored under it. |
| `type` | `"account"` \| `"short_text"` \| `"long_text"` \| `"select"` | **account**: their username on another platform. **select**: a dropdown. |
| `platforms` | `["instagram"]` | `account` only: which platform. |
| `label` | string (≤ 45) | Shown above the field. |
| `required` | boolean (default `false`) | Must be filled in. |
| `placeholder` | string (≤ 100), optional | Hint text. |
| `options` | string[] (1–25) | `select` only: the choices. |
| `locked` | boolean (read-only) | `true` on account fields Synapse requires. Don't let admins remove them. |

Instagram usernames are cleaned up (`@`, links and capitals removed) and checked. One Discord account per Instagram username. Someone already active on Instagram who then enters on Discord with that username becomes one person.

## Announcements

Every field optional; defaults shown.

| Field | Type | Default | Posts… |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch. (`testMode` always silences.) |
| `started` | boolean | `true` | "🎉 … is live!" |
| `closed` | boolean | `true` | "🔒 … is closed", with totals. |
| `extended` | boolean | `true` | When the end time or cap goes up. |
| `milestones` | `{ enabled, every }` | `{ true, 100 }` | "🎯 100 entrants!" every `every` people. |
| `capacity` | `{ enabled, percents }` | `{ true, [50,75,90,95,99] }` | Only with `maxParticipants`. 99% has [Extend]. |
| `countdown` | `{ enabled, hours }` | `{ true, [336,72,24,5] }` | Countdowns this many hours before the end, with [Extend]. |

## WinnerSettings

```jsonc
{ "count": 1, "select": "manual", "notify": "manual", "notifyDelayMinutes": 30,
  "message": null, "defaultMessage": "🎉 Congrats {name}! …", "claimHours": 12, "history": [ /* Winner */ ] }
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `count` | integer (1–100) | `1` | How many winners. |
| `select` | `"auto"` \| `"manual"` | `manual` | **auto**: drawn at close, weighted by entries. **manual**: admins pick or draw. |
| `notify` | `"auto"` \| `"manual"` | `manual` | **auto**: the bot DMs [Accept]/[Decline]. **manual**: admins reach out and report. |
| `notifyDelayMinutes` | integer (0–10080) | `30` | Wait before the auto DM. |
| `message` | string (≤ 1500), *nullable* | `null` | DM text; `null` = default. Placeholders: `{name}`, `{giveaway}`, `{deadline}`. |
| `defaultMessage` | string (read-only) | — | Show as the placeholder when `message` is null. |
| `claimHours` | integer (1–720) | `12` | Time to accept, from when the DM is sent. |
| `history` | `Winner[]` (read-only) | — | Every pick, in order. |

## Winner

Read-only.

| Field | Type | Meaning |
|---|---|---|
| `id` | integer | |
| `personId` | integer \| null | The winning person. `null` once personal data is deleted. |
| `person` | `{ discordId, discordUsername, igUsername }` \| null | Who won, kept 1 year after the end. |
| `status` | below | Where they are. |
| `checks` | `{ ruleId, label, confirmed, by?, at? }[]` | Winner checks. `confirmed`: `true`, `false` or `null` (waiting). |
| `selectedBy` | string | `"auto"` or `"admin:<email>"`. |
| `entriesAtDraw` | integer | Their entries when picked. |
| `notifyAt`, `notifiedAt`, `claimDeadline`, `respondedAt` | timestamp \| null | Timeline. |
| `outcomeBy` | string \| null | Who reported the outcome. |

| `status` | Meaning |
|---|---|
| `checking` | Waiting for winner checks to be confirmed. |
| `pending` | Ready: DM goes out after the delay (auto), or admins reach out (manual). |
| `notified` | DM sent, waiting for Accept/Decline. |
| `unreachable` | DMs closed or no Discord. Admins reach out and report. |
| `accepted` | Done. |
| `declined`, `expired` | Kept in history. Entries disqualified; slot opens again. |

## Person

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
  "breakdown": [ { "ruleId": 7, "count": 1, "weight": 1, "entries": 1, "label": "…", "description": "…" } ],
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
| `id` | Person ID, for overrides, disqualifying and picking. |
| `discord` | `{ id, username }`, or `null` if only active on Instagram so far. |
| `accounts` | Usernames per platform. |
| `answers` | Form answers by field `id` (account fields are in `accounts`). |
| `eligible` | Every required rule met, and not disqualified. |
| `missing` | Labels of required rules not met yet. |
| `winnerChecks` | Checks they'll need if they win. Don't block eligibility. |
| `entries` | `base` (`baseWeight` if eligible), `bonus`, `manual`, `total`. All 0 if not eligible. |
| `breakdown` | Per bonus rule: actions counted, weight, entries. |
| `requirements` | Per required rule: `met`, and `via` (`activity`, `override`, `member`, `winner-check`, or `null`). |
| `overrides` | Active [overrides](#override). |
| `inServer` | In the Discord server: `true`, `false`, or `null` if unknown. |
| `disqualified` | `{ reason, by, at }`, or `null`. |
| `activity` | Everything recorded. `removed` is `false` or why (e.g. "Comment deleted or hidden"). |

## Override

| `kind` | Send | Effect |
|---|---|---|
| `requirement_met` | `{ kind, ruleId, reason? }` | Counts a **required** rule as met for this person. |
| `manual_entry` | `{ kind, label, weight?, reason? }` | Adds `weight` entries (default 1). |

Returned in a Person as `{ id, kind, ruleId, label, weight, reason, by, at }`.

## Preview

```jsonc
{ "becomeEligible": 0, "becomeIneligible": 12, "entriesBefore": 940, "entriesAfter": 812,
  "changed": [ { "personId": 7, "discord": "sam", "instagram": "sam_ig",
                 "before": { "eligible": true, "entries": 3 }, "after": { "eligible": false, "entries": 0 } } ] }
```

## Stats

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

## InstagramSync

```jsonc
{ "lastRunAt": "…", "lastSuccessAt": "…", "lastError": null, "lastReason": "scheduled",
  "lastResult": { "comments": { "posts": 2, "comments": 9, "removed": 1 }, "taggedPosts": { "posts": 0 } } }
```

`lastReason`: `scheduled` (every 30 minutes), `post-set` (a new post was saved), `manual` (Sync now), `final` (after close).

## Flag

```jsonc
{ "id": 12, "key": "comment_post_missing:6:27", "code": "comment_post_missing", "severity": "blocking",
  "giveawayId": 6, "ruleId": 27, "winnerId": null,
  "message": "GTA VI Giveaway: Rule #4 (Instagram: commented on a giveaway post (tagging a friend) (no post yet)) has no post, so its comments don't count yet.",
  "since": "…", "open": true, "snoozedUntil": null, "dismissedAt": null,
  "actions": [], "resolveUrl": "https://admin.bostonblerds.com/giveaways/6" }
```

| Field | Meaning |
|---|---|
| `id` | Use with `/flags/:flagId/snooze` or `/dismiss`. |
| `key` | Stable name for this exact flag. |
| `code`, `severity` | What it is and how urgent. See [Flags](#flags). |
| `giveawayId` | `null` for flags not about one giveaway (e.g. the Instagram token). |
| `ruleId`, `winnerId` | What it's about, when relevant. |
| `message` | Ready to show. May contain Discord mentions like `<@123>`. |
| `since` | When it appeared. |
| `open` | `false` while snoozed or once dismissed. |
| `actions` | What can be done besides fixing it: `["snooze"]`, `["dismiss"]` or `[]`. |
| `resolveUrl` | Where to fix it on the dashboard. |

---

## Old v1 fields (deprecated)

Still accepted so the current dashboard keeps working; they'll be removed once it's updated.
- **Accepted and translated:** `entryMethods`, `entryChannel` and Discord `settings.channel` (put on `enter` rules without a channel), `igPost` (put on every comment rule), flat `rules` (`ig_comment`, `ig_story`, `ig_tag`), `ig_username` form fields, flat winner fields (`winnerCount`, `winnerSelect`, `winnerNotify`, `notifyDelayMinutes`, `winnerMessage`, `claimHours`; the `winners` object wins if both are sent), `{ entrantId }` when picking.
- **Old routes:** `GET /entrants`, `POST /bonuses` (= a manual entry), `DELETE /bonuses/:id`, `/entrants/:id/disqualify` and `/restore`, `POST /winner`.
- **Extra response fields:** `entryMethods`, `entryChannel` (the first entry channel), `igMediaId`, `igPermalink`, `igPostedAt`, flat `rules`, flat winner fields, `defaultWinnerMessage`, `discordEntrantCount`, `igSync`.
- **Breaking:** `winners` used to be the list of picks. It's now the settings object; picks are in `winners.history`.
