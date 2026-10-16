# GTA VI Giveaway — BB-Bot Requirements

**Status:** Draft v3 · **Owner:** Boston Blerds · **Launch:** Oct 19, 2026 · **Entries close:** Nov 20, 2026 @ 10:30 PM ET

BB-Bot is the Discord-facing worker for Synapse. For this campaign its only job is to **capture, verify and export giveaway entries**. Everything else in the Synapse masterdoc (XP, moderation, activity) is out of scope.

---

## 1. Entry rules (from campaign terms)

| Action | Type | Entries | How it's captured | Verified by |
|---|---|---|---|---|
| Join Discord + post IG username in `#gta-giveaway` | **Required** | 1 | Bot: "Enter" button → form | Bot (automatic) |
| Follow @BostonBlerds on IG | **Required** | — | Self-attested checkbox in form | Admin spot-checks **winner only** |
| Comment on giveaway post + tag a friend | Bonus | +1 (max 1) | Bot pulls comments from the IG post (later: IG webhook) | Bot (comment must contain an `@tag`) |
| Share giveaway post to IG Story + tag @BostonBlerds | Bonus | +1 (max 1) | Admin logs manually until Meta approval, then the IG webhook | Admin → bot |
| Attend Retro Gaming Night, ticket scanned | Bonus | +1 (max 1) | Posh webhook supplies the IG username at RSVP; the scan confirms attendance | Posh check-in data |

**Max entries per person: 4.** Every bonus is capped at 1. No eligibility restrictions (no age, location or staff limits). **1 winner** (prize: GTA VI, logistics coordinated after the draw).

> **Instagram limits:** Instagram's API can't tell you whether a given user follows you, so follows are self-attested. Story-mention and comment *webhooks* need Meta approval (see §6a). Until we're approved, the bot pulls comments from our *own* post, which only needs standard access, and admins log Story shares by hand.

---

## 2. User flow (entrant)

Entrants never type a slash command. They use the buttons on the pinned message.

1. Sees IG announcement → joins Discord → goes to `#gta-giveaway`.
2. The pinned bot message explains the rules. It has two buttons: **🎮 Enter Giveaway** and **📋 My Entries**.
3. **Enter** opens a form:
   - Instagram username (required)
   - "I follow @BostonBlerds on Instagram" (required confirmation)
4. The bot replies **privately**: "✅ Username captured! Don't forget to follow @BostonBlerds on Instagram". The reply also shows their entry count and how to earn bonuses. Nothing is posted publicly, because the bot can't confirm follows.
5. **My Entries** replies privately with the person's entries and which bonuses they have.
6. Pressing **Enter** again opens the form pre-filled, so the person can edit their IG username before the deadline. The old value stays in the audit log.

**Rules enforced by the bot**
- One base entry per Discord account.
- One Discord account per IG username. A second claim is rejected and flagged for admins.
- IG usernames are cleaned up (strip `@`, lowercase, trim) and must match IG's format (letters, numbers, `.` and `_`, up to 30 characters).
- No entries or changes after **Nov 20, 2026 10:30 PM America/New_York**.
- An entrant must still be in the server at export time. Anyone who left is excluded and listed in the report.

---

## 3. Admin flow

**Every slash command is admin-only.** That includes the existing `/playing`, `/activegames` and `/communitycode`. Two layers enforce it:
1. Discord's default permission (`Manage Server`), which hides commands from everyone else.
2. A check in the bot itself on every command against an allow-listed admin role. Server owners can override Discord's default in Integrations settings, so the bot's own check is the real gate.

All admin replies are private.

| Command | Purpose |
|---|---|
| `/giveaway setup channel:#gta-giveaway` | Posts and pins the rules message with its buttons |
| `/giveaway lookup user:<@discord or ig name>` | Shows one person's entries and history |
| `/giveaway sync-comments` | Pulls comments from the giveaway IG post and awards comment bonuses |
| `/giveaway bonus ig_user:<name> type:<story\|comment\|irl>` | Awards a bonus by hand (Story shares until Meta approval) |
| `/giveaway revoke ig_user:<name> type:<…> reason:<…>` | Removes an entry or bonus (spam, fake account, etc.) |
| `/giveaway import-checkins file:<csv>` | Marks IRL attendance from the Posh check-in export |
| `/giveaway stats` | Totals: entrants, bonuses by type, unmatched bonuses, flags |
| `/giveaway export` | Returns the CSVs in §4 |

**Bonuses for people who haven't entered yet:** a bonus can arrive for an IG username with no base entry. The bot stores it as *unmatched*, and it attaches automatically if that person enters before the deadline. Unmatched bonuses never count on their own.

---

## 3a. Posh integration (IRL bonus)

Posh sends a webhook when someone RSVPs or buys a ticket (`type: "new_order"`). The payload includes:
- `account_instagram`: the buyer's IG handle, if their Posh profile has one
- `custom_fields[]`: we add an optional RSVP question: *"Entering our GTA VI giveaway? Drop your Instagram username."*
- `event_id`, `order_number`, `items[]`, plus `cancelled` / `refunded`

**Flow**
1. `POST /webhooks/posh/<secret>` receives the order. The bot takes the IG username from the custom field, or from `account_instagram` if the field is empty, and stores an **RSVP**. An RSVP is *not* a bonus yet.
2. Cancelled or refunded orders remove the RSVP.
3. **Attendance needs the ticket scan.** Posh's webhook has no check-in data (confirmed). After the event an admin exports Posh's check-in list and runs `/giveaway import-checkins`. Each RSVP whose `order_number` was scanned becomes a +1 IRL bonus.
4. Fallback if the check-in export doesn't work: an admin at the door runs `/giveaway bonus type:irl`.

To confirm before Nov 20: the columns in Posh's check-in export.

---

## 4. Outputs (for the spinner wheel)

`/giveaway export` returns:

- **`wheel.csv`**: one row **per entry**. A person with 3 entries appears 3 times, so the wheel is weighted correctly.
  `discord_username, discord_id, ig_username, entry_type`
- **`entrants.csv`**: one row per person.
  `discord_username, discord_id, ig_username, base, comment, story, irl, total_entries, entered_at, in_server`
- **`audit.csv`**: every action, with who, what, when, the source, and which admin did it.

**Winner flow (in person, Nov 20):**
1. Import check-ins → close → export `wheel.csv` → load it into the spinner app.
2. **Disconnect the projector or screen.** Spin privately.
3. Verify that the result follows @BostonBlerds on IG and is still in the Discord. If not, remove them and spin again privately.
4. **Reconnect the screen** and do the public spin.
5. The winner is contacted by **Discord DM** to coordinate getting their copy of GTA VI.

> 📝 **Spinner app requirement (separate project, don't forget):** the app must support a private "verification spin" with the screen disconnected, then a repeat public spin. It must load `wheel.csv` (weighted, one row per entry). Decide how the public spin relates to the verified result before Nov 20.

---

## 5. Data model (Postgres)

```
giveaways        id, slug ('gta6-2026'), channel_id, ig_media_id, posh_event_id, opens_at, closes_at
entrants         id, giveaway_id, discord_id (unique per giveaway), discord_username,
                 ig_username (unique per giveaway), follow_attested, created_at, updated_at
entry_actions    id, giveaway_id, entrant_id (nullable = unmatched), ig_username,
                 type (BASE|IG_COMMENT|IG_STORY|IRL), source (discord|ig_api|ig_webhook|admin|posh),
                 source_ref (comment id / order number), revoked_at, revoked_reason,
                 created_by, created_at
                 UNIQUE (giveaway_id, ig_username, type)   -- enforces max 1 per bonus
posh_orders      order_number (pk), event_id, ig_username, raw jsonb, cancelled, checked_in_at, received_at
audit_log        id, actor, action, payload jsonb, created_at
```

This follows the Synapse Phase 1 pattern (Discord identity + audit log), so the data can move into Synapse later.

---

## 6. Infrastructure

- **Host:** Oracle Cloud Always Free, **us-ashburn-1**, Ampere A1 VM (ARM), Ubuntu. Ashburn often runs out of A1 capacity. Fallbacks: retry in a different availability domain, or use the always-free AMD micro VM (1 GB RAM), which is enough for the bot plus Postgres.
- **Runtime:** Docker Compose with `bot` (Discord + a small Express web server for webhooks) and `postgres`. No Redis yet; it comes back with activity aggregation.
- **Public HTTPS:** the Posh and IG webhooks need a public HTTPS URL. Plan: **Cloudflare Tunnel** (`cloudflared` container) to `bot.bostonblerds.com`. The domain is already on Cloudflare, so the VM opens no inbound ports and Cloudflare handles HTTPS.
- **Backups:** nightly `pg_dump` on the VM, plus a copy off the VM.
- **Secrets:** `.env` on the VM only, never committed: `DISCORD_TOKEN`, `CLIENT_ID`, `SERVER_ID`, `ADMIN_ROLE_NAME=admin`, `IG_ACCESS_TOKEN`, `IG_APP_SECRET`, `POSH_WEBHOOK_SECRET`, `POSTGRES_*`.

## 6a. Meta app approval (runs in parallel)

Goal: receive `comments` and Story-mention webhooks automatically. Meta requires:
- [ ] A Meta developer app using **Instagram API with Instagram Login**, connected to @BostonBlerds (Business account)
- [ ] **Business Verification** for Boston Blerds (legal or business documents)
- [ ] Public **Privacy Policy** and **Data Deletion** URLs
- [ ] **App Review** for `instagram_business_manage_comments` and `instagram_business_manage_messages`, with a screencast showing how the app uses them
- [ ] App switched to **Live** mode

Until approval: the bot pulls comments with standard access, and admins log Story shares daily (**Stories expire after 24 hours**). Once approved, webhooks take over and admins only handle edge cases.

---

## 7. Delivery plan

| By | Deliverable |
|---|---|
| **Oct 18** | VM up; bot running 24/7; admin-only commands; Enter and My Entries buttons, form, DB; `lookup`, `stats`, `export`, `bonus`, `revoke` |
| **Oct 19** | 🚀 Launch: `/giveaway setup` posts the pinned message. Submit the Meta app for review. |
| Oct 26 | IG comment sync; HTTPS domain live |
| Oct 29 | Posh webhook + RSVP question live, before the tournament announcement |
| On Meta approval | Switch comments and Story shares to webhooks |
| Nov 20 | Import check-ins → close → export → spin |
| Stretch | **Admin web viewer**: a read-only page listing entrants, bonuses, flags and the audit log, with search and CSV download. It sits behind Discord login and is restricted to the admin role. |

---

## 8. Open questions

1. **Posh:** need a sample check-in export to map its columns.
2. **Prize claim window:** how long does the winner have to reply to the Discord DM before a re-draw?
3. **Story logging:** who logs Story shares day to day until Meta approval?

**Decided:** admin role = `admin` · no eligibility restrictions · 1 winner, contacted by Discord DM · every bonus max 1 · private confirmation only (no public feed) · domain `bostonblerds.com` on Cloudflare · repo renamed to `synapse` locally and on GitHub.
