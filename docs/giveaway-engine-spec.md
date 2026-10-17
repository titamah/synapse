# Giveaway Engine — Spec

**Status:** Draft v1 · **Owner:** Boston Blerds · **Replaces:** the hardcoded GTA VI setup in `src/giveaway/service.ts`

Run any giveaway from the admin dashboard: set the dates, the entry form and the rules, then click **Create**. BB-Bot collects entries and bonuses into Synapse. Admins decide eligibility and pick the winner; the engine only **collects and exports data**.

---

## 1. Concepts

| Term | Meaning |
|---|---|
| **Giveaway** | One campaign: name, dates, entry form, rules, channels. |
| **Entrant** | A Discord member who ran `/giveaway enter`. Their form answers are saved with the entry. |
| **Action** | Something a person does that the system can detect (see §4). |
| **Rule** | How many times an action counts, and optionally when and how often (see §5). |
| **Entry** | One ticket on the wheel. Base entry = 1, plus one per counted action. |

**One giveaway open at a time.** Story mentions don't say which post they're about, so two open giveaways couldn't be told apart.

---

## 2. Lifecycle

```
scheduled ──(start time)──► open ──(end time / closed early)──► closed ──► winner recorded
```

- **scheduled:** created, not started. `/giveaway` doesn't exist. Activity is ignored.
- **open:** `/giveaway enter` works. Activity counts if a rule allows it.
- **closed:** `/giveaway` is removed. Activity is **ignored forever**, never counted retroactively.
- **No "pause."** Close early or edit the end time instead.
- Start and end are entered in **Eastern time**. Extending = editing the end time while open.

---

## 3. Settings (per giveaway)

| Setting | Example |
|---|---|
| Name | GTA VI Giveaway (export files use it: `GTA-VI-Giveaway-entries.csv`) |
| Start / end | Oct 19, 2026 12:00 PM ET → Nov 20, 2026 10:30 PM ET |
| Entry channel | `#gta-giveaway`. `/giveaway enter` only works there. |
| Instagram hashtag | `#BBxGTAVI`. Required if any Instagram rule exists. |
| Entry form | Up to **5 fields** (§3a) |
| Rules | §5 |
| Max participants | Optional (open question, §11) |
| Announcements | On/off per alert type, milestone size, countdown points (§7) |
| Test mode | Creates a giveaway that **posts no announcements**, for trying things out |

### 3a. Entry form
`/giveaway enter` opens a Discord form built from the giveaway's fields. Discord allows **up to 5 fields** per form.

- Field types: short text, long text, dropdown (e.g. PS5 / Xbox / PC), checkbox. Each can be required or optional.
- **Instagram username** is a built-in field type with validation and normalization. It is **required whenever an Instagram rule exists**, because it's how comments and Story mentions are matched to people.
- Running `/giveaway enter` again opens the form pre-filled so people can edit their answers until the giveaway closes.
- The bot's only replies to entrants: "captured" / "updated", plus a configurable reminder line (e.g. "Don't forget to follow @BostonBlerds!").

---

## 4. Action types (the menu)

| Action | Detected by | Options |
|---|---|---|
| **Instagram comment** on the giveaway post | Instagram webhook + 10-minute sync | "Must tag a friend" (an @mention other than BB or the commenter) |
| **Instagram Story mention** of @BostonBlerds | Instagram `messages` webhook | — |
| **Manual** | An admin adds it from the dashboard | Label, e.g. "Attended Retro Gaming Night" |

- The **base entry** (`/giveaway enter`) is always on and always worth 1.
- **IG follows** can't be detected. They're a stated requirement that admins check by hand for the winner only.
- Adding a new action type (e.g. "reacted to a Discord post") requires code once; then it's in the menu for every future giveaway.

---

## 5. Rules ("+ Add rule")

Every bonus is a rule built from the same pieces:

> **Action** + **max counted** + optional **time window** + optional **frequency**

| Piece | Meaning |
|---|---|
| Action | From §4 |
| Max counted | How many times this rule can award an entry to one person |
| Time window | Only counts between these times (default: the whole giveaway) |
| Frequency | At most once per day / week / N minutes |
| Options | Action-specific, e.g. "must tag a friend" |

**How an action is counted:** find every rule it fits, and count it under the **most specific** rule that still has room (narrowest time window first, in order of the rules list after that). If none has room, it's recorded but earns nothing.

**Example: GTA VI**
| # | Action | Max | Window | Frequency | Options |
|---|---|---|---|---|---|
| 1 | Story mention | 5 | Nov 20, event hours (TBD) | 1 per 10 min (TBD) | — |
| 2 | Story mention | 1 | whole giveaway | — | — |
| 3 | Comment | 1 | whole giveaway | — | must tag a friend |

Online-only: up to 3 entries (base + comment + Story). At the event: up to 8.

---

## 6. Instagram

The Instagram app keeps sending everything to Synapse unchanged. The giveaway decides what counts:

- **Giveaway post:** found automatically, the first @BostonBlerds post whose caption has the giveaway's hashtag. Comments only count on that post.
- **Story mentions** count only while the giveaway is open and after the post went up.
- Storage stays filtered: only giveaway-post comments and Story mentions are saved; regular DMs are dropped.
- **Token auto-renewal:** BB-Bot exchanges the Instagram token for a fresh 60-day one every week, so it never expires while the bot runs.

---

## 7. Discord admin feed & announcements

All bot alerts go to **`#community-updates`** (admin-only) first.

| Alert | When |
|---|---|
| Giveaway started | At start time |
| Milestone | Every N entries (e.g. 100) |
| Countdown | Configurable, e.g. 14 days, 3 days, 24 hours left |
| Extended | End time moved |
| Closed | At end time, or closed early |
| **Who won?** | After close, with a **[Record winner]** button: an admin picks the member, saved to the giveaway's history |

- **Post publicly:** right-click any alert → **Apps → "Post to giveaway channel"** reposts it as a rich embed in the entry channel.
- **Buttons on alerts:** e.g. "Ends in 24h" → **[Extend]**. (Details TBD.)
- Alerts never repeat after a bot restart. Each alert is recorded once sent.

---

## 8. Exports (dashboard)

| File | Rows | Columns |
|---|---|---|
| `[Name]-entries.csv` | One per **entry** (for the spinner) | discord username, discord ID, IG username, entry source (base / rule) |
| `[Name]-entrants.csv` | One per **person** | discord username, discord ID, form answers…, entries per rule, total, entered at, still in server |
| `[Name]-audit.csv` | One per action | when, who, what, details |

---

## 9. Admin API (for admin.bostonblerds.com)

Protected by a secret key only the dashboard knows. Every write includes **who** did it (the dashboard user's email), recorded in the audit log.

```
GET    /admin/giveaways                      list
POST   /admin/giveaways                      create
GET    /admin/giveaways/:id                  settings + stats
PATCH  /admin/giveaways/:id                  edit (e.g. extend end time, rules)
POST   /admin/giveaways/:id/close            close early
GET    /admin/giveaways/:id/entrants         entrants with entries per rule
POST   /admin/giveaways/:id/bonus            add a manual entry
DELETE /admin/giveaways/:id/bonus/:bonusId   remove an entry
POST   /admin/giveaways/:id/entrants/:entrantId/disqualify | restore
POST   /admin/giveaways/:id/winner           record winner
GET    /admin/giveaways/:id/audit
GET    /admin/giveaways/:id/export/{entries|entrants|audit}.csv
```

---

## 10. Data changes

- `giveaways`: + name, status, starts_at, ends_at, entry_channel, ig_hashtag, form_fields (json), max_participants, announcements (json), test_mode, winner_entrant_id, winner_recorded_by/at
- `giveaway_rules` (new): giveaway_id, position, action, max_count, window_start/end, frequency, options (json)
- `entrants`: + answers (json)
- `bonuses`: + rule_id (which rule awarded it); the old "max 1 per type" constraint is replaced by rule limits
- `announcements_sent` (new): giveaway_id, kind, key. Prevents duplicate alerts.
- `settings` (new): stores the auto-renewed Instagram token

**GTA VI moves in as giveaway #1** with the rules in §5. Its existing entries and bonuses are kept.

---

## 11. Open questions

1. **Event hours** for Retro Gaming Night (must end by 10:30 PM, when entries close).
2. **10-minute spacing** between counted event Stories: yes or no?
3. **Max participants:** if a cap is reached before the end, close automatically, or stay open and reply "full"? Or skip caps for now?
4. **Alert buttons:** which alerts get buttons, and what they do beyond [Extend].
5. **Winner DM:** should recording a winner also DM them automatically (with the 12-hour claim window)?

## Out of scope (for now)
Spinner / remote display app, member-facing pages, Posh, Discord Scheduled Events, XP.
