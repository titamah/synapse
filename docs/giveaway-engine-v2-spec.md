# Giveaway Engine v2: Platforms, Requirements & Activity

**Status:** Draft v2 · **Owner:** Boston Blerds · **Replaces:** `entryMethods` and the flat `rules` list in v1

Field-by-field reference: [giveaway-object.md](giveaway-object.md).

A giveaway is built the way you'd describe it out loud: *"Discord + Instagram: you must enter on Discord and follow us; comments and Stories are bonuses."*

**Platforms → rules (required or bonus) → eligibility and entries.** Everything people do is recorded in an activity log; eligibility and entries are calculated from it, so rule changes apply retroactively and order never matters.

---

## 1. The model

```jsonc
{
  "name": "GTA VI Giveaway",
  "startsAt": "2026-10-19T16:00:00-04:00",
  "endsAt":   "2026-11-20T22:30:00-05:00",
  "baseWeight": 1,                                   // "qualifying is worth N entries" (see §3 for why it's not per rule)
  "platforms": [
    {
      "platform": "discord",
      "settings": { "channel": "gta-giveaway" },    // null when no rule needs a channel (e.g. member-only)
      "rules": [
        { "action": "enter",  "type": "required" },  // /giveaway enter + the entry form
        { "action": "member", "type": "required" }   // still in the server when entries are counted
      ]
    },
    {
      "platform": "instagram",
      "rules": [
        { "action": "follow",  "type": "required", "check": "winners" },
        { "action": "comment", "type": "bonus", "weight": 1, "maxCount": 1,
          "options": { "post": "https://www.instagram.com/p/…", "requireTag": true } },     // main post
        { "action": "comment", "type": "bonus", "weight": 1, "maxCount": 1,
          "options": { "post": "https://www.instagram.com/reel/…" } },                       // promo Reel
        { "action": "story",   "type": "bonus", "weight": 1, "maxCount": 1 },
        { "action": "story",   "type": "bonus", "weight": 1, "maxCount": 5,
          "windowStart": "2026-11-20T19:00:00-05:00", "windowEnd": "2026-11-20T22:30:00-05:00" }
      ]
    }
  ],
  "formFields": [
    { "id": "ig", "type": "account", "platforms": ["instagram"], "label": "Instagram username", "required": true, "locked": true }
  ]
}
```

### Rule fields
| Field | Applies to | Meaning |
|---|---|---|
| `action` | all | What the person does (see §2) |
| `type` | all | `required` (counts toward eligibility) or `bonus` (adds entries) |
| `min` | required | Times it must be done. Default 1. Stored now, **not shown in the dashboard** until needed. |
| `check` | manual actions | `winners` (default: an admin confirms for the winner) or `everyone` |
| `weight` | bonus | Entries per counted action. Default 1. |
| `maxCount` | bonus | Max counted per person |
| `windowStart` / `windowEnd` | all | Only actions in this window count (always clamped to the giveaway's dates) |
| `frequency` | bonus | At most once per `day` / `week` (Eastern) |
| `options` | some | `post` (comment: which post, required), `requireTag` (comment must @tag a friend), `captionIncludes` (tagged post caption must contain text) |

---

## 2. Platforms and actions

| Platform | Settings | Actions |
|---|---|---|
| **Discord** | `channel` (where `/giveaway enter` works; **null** when no rule needs it) | `enter` (auto) · `member` (auto: in the server when entries are counted). *Later:* auto-enter every member without them doing anything |
| **Instagram** | — (each comment rule names its post) | `follow` (**manual**) · `comment` (on the rule's `post`) · `story` · `tag` (someone's feed post that tags us, posted in the window; `captionIncludes` can require a hashtag) |
| *Later: Posh, TikTok* | — | e.g. Posh `attend` (ticket scanned) |

- **Manual vs. automatic is a property of the action** (follow = manual; the rest = auto). The dashboard never asks.
- **Selecting a platform** unlocks its settings and actions. Discord `enter` is what makes the entry form, the channel setting and `/giveaway enter` exist. A Discord platform with only `member` has no form, command or channel.
- The dashboard **pre-selects `member`** (required) when Discord is added; it can be removed.
- Every selected platform needs **at least 1 rule**.

---

## 3. Eligibility and entries

**Eligible** = every **required** rule on every selected platform is met (**AND**), **plus** not disqualified.
- There's no hidden "still in the server" check: that's the Discord **`member`** rule. It's evaluated whenever entries are counted (dashboard, export, draw), so someone who leaves becomes ineligible from then on. Giveaways that don't require `member` keep counting people who left.
- If a giveaway has **no required rules at all**, any counted action makes you eligible (that's how **OR** giveaways work).
- **Manual rules with `check: "winners"`** don't block eligibility; they're confirmed in the winner flow (§6). `check: "everyone"` is ticked per person in the dashboard.
- **Not supported (decided):** "this AND (that OR that)". Can be added later as an optional platform grouping without changing existing giveaways.

**Entries** = `baseWeight` (if eligible) + Σ (counted bonus actions × that rule's `weight`).
- **Why one base weight, not a weight per required rule:** the base entry is earned by meeting *all* requirements together; partial completion is worth nothing. Per-rule weights would make the base "the sum of required weights," so adding a requirement would silently change everyone's base, and manual winners-only rules (confirmed for one person) couldn't contribute. The dashboard shows it as "Qualifying is worth **N** entries."
- **An action used to meet a requirement is part of the base entry and does not also earn a bonus.** Only additional actions earn bonuses. *Example:* required = comment with a tag, bonus = any comment → 1st tagged comment = base; every comment after that = bonus.
- Bonus counting uses the v1 rule engine: the most specific window with room wins, then list order.

**Examples**
| Setup | Means |
|---|---|
| Discord `enter` required · Instagram all bonus | Discord, IG as extra entries |
| Discord `enter` required · Instagram `follow` required + bonuses | Discord **AND** Instagram (GTA) |
| Discord `enter` bonus · Instagram `comment` bonus (nothing required) | Discord **OR** Instagram |
| Instagram `comment` required only | Instagram-only giveaway |

---

## 4. People, accounts and the entry form

- A **person** has a Discord account and/or platform **accounts**: `{ "instagram": "alex.plays", "tiktok": null }`.
- People are created from **any** activity, in any order. Someone who comments on IG before joining the Discord shows up right away as "⚠️ missing: Discord entry," and their activity counts once they qualify.
- **The entry form is built from the platforms:** when Discord `enter` is required and another platform is selected, that platform's **account field is added, required and locked** (it's how one person is linked across platforms). Custom questions go below it; max 5 fields total.
  - Field types: `account` (one platform = text box; several = dropdown + text box), `short_text`, `long_text`, `select`.
- **The API enforces this** when a giveaway is saved; the dashboard mirrors it.
- **Username conflicts** (two Discord accounts claiming the same IG username) are flagged in `#community-updates` for a human to resolve.

---

## 5. Activity log (source of truth)

- **Every detected action is stored:** person, platform, action, time, source ID (comment / Story / post), details. This includes actions that don't match any rule today.
- **Eligibility and entries are calculated from the log** whenever they're read (dashboard, exports, draws). They're never stored, so they can't go stale.
- **Rule changes are retroactive** within the giveaway's dates. Someone who commented before commenting became required still counts.
- Comments and tagged posts are also re-read from Instagram (every 30 min, on post set, and at close), and deleted or hidden ones are marked removed.

**Changing rules while open:** allowed. The API offers a **dry run** ("this change makes 12 people ineligible and 3 eligible") so the dashboard can confirm first.

**Per-person overrides** (logged with who and why):
- **Count a requirement as met** for someone (grandfathering)
- **Disqualify / restore**
- **Manual entries** (label + weight)

**Size:** about 300–500 bytes per action. A month-long giveaway with 1,000 people and about 10 actions each is about 5 MB (plus about 10–20 MB of raw webhooks). That's around 0.05% of the VM's disk.

---

## 6. Winners (changes to v1)

Unchanged: winner count, auto/manual select (weighted by entries), auto/manual notify, the DM with Accept/Decline, claim window, redraws, history.

**New: winner checks.** When a winner is picked and the giveaway has manual `check: "winners"` rules, the post in `#community-updates` lists them with **[✓ Confirmed] [✗ Not met]** buttons. **The DM is held until every check is confirmed.** ✗ disqualifies the person and redraws (auto) or asks admins to pick (manual).

---

## 7. Exports (server-side)

| File | Rows | Use |
|---|---|---|
| `entries.csv` | One row **per entry** (weights expanded: 11 entries = 11 rows) | Random pick from a list |
| `entrants.csv` | One row **per person**: accounts, form answers, eligible, missing, per-rule count × weight, total | Spreadsheets, weighted-list tools, review |
| `activity.csv` | One row **per action** | "Why does Alex have 11?" |
| `audit.csv` | Every admin change | Accountability |

`entries.csv` and draws use **eligible people only**. The dashboard tables use the same calculation, so they always agree.

---

## 8. Data retention

**90 days after a giveaway ends:**
| Kept | Deleted |
|---|---|
| Giveaway setup (platforms, rules, settings) | People, accounts, form answers |
| **Stats snapshot** taken at close (entrants, entries, per-rule and per-platform totals) | Activity log and entries |
| Winner and history, for **1 year**, then anonymized | Raw webhook data |
| Admin change history | Per-person audit entries |

- A **7-day heads-up** in `#community-updates` before deletion ("export now if you need it").
- Past giveaways in the dashboard keep showing setup, stats and winner; the entrants table shows "removed per privacy policy."
- The Delete button still removes everything immediately.

---

## 9. Unchanged from v1
Discord updates (toggles, Extend, Post to giveaway channel), `/admin giveaway timer`, `/giveaway` only while open, winner flow, Instagram sync and webhooks, token auto-renewal, delete with name confirmation, the admin API's style (null-friendly, extra fields ignored).

---

## 10. Migration from v1

| v1 | v2 |
|---|---|
| `entryMethods: ["discord"]` | Discord platform with `enter` required |
| `entryMethods: ["instagram"]` | Instagram platform; existing IG rules become bonus, plus one marked required (the giveaway's first IG rule) |
| `entryMethods: ["discord","instagram"]` (OR) | Discord `enter` **bonus** + Instagram rules bonus (nothing required = OR) |
| `rules[]` | Instagram platform rules, `type: "bonus"`, `weight: 1` |
| `igMediaId` / `igPermalink` | Instagram `posts[0]` |
| `entryChannel` | Discord `settings.channel` |
| Entrants + bonuses | People + activity log (entries derived) |

**GTA #1 after migration:** Discord `enter` + `member` required · Instagram: `follow` required (winners) is **added**, the comment, Story and event-Story bonuses carry over · form unchanged.

Every migrated Discord giveaway gets `member` required, matching v1's implicit "still in the server" check.

The API keeps accepting v1 fields for a transition period and translates them, so the dashboard can switch over gradually.

---

## 11. Build order
1. Activity log + derived eligibility/entries (with the v1 data migrated); exports switch over
2. Platforms + required/bonus rules + weights + API (with v1 translation) + form enforcement
3. Winner checks (manual rules) + conflict alerts
4. Rule-change dry run + per-person overrides
5. Retention job + stats snapshots + 7-day warning
6. Our-posts hashtag auto-include, multiple posts
