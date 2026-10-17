# GTA VI Giveaway — BB-Bot Requirements

**Status:** Draft v4 · **Owner:** Boston Blerds · **Launch:** Oct 19, 2026 *(may be postponed until the Meta app is approved; see §6a)* · **Entries close:** Nov 20, 2026 @ 10:30 PM ET

BB-Bot is the Discord-facing worker for Synapse. For this campaign its job is to **capture giveaway data into the database**. Admins view and download that data on **admin.bostonblerds.com**, not in Discord. Everything else in the Synapse masterdoc (XP, moderation, activity) is out of scope.

---

## 1. Entry rules (from campaign terms)

| Action | Type | Entries | How it's captured | Verified by |
|---|---|---|---|---|
| Join Discord + submit IG username | **Required** | 1 | `/giveaway enter` → form | Bot (automatic) |
| Follow @BostonBlerds on IG | **Required** | — | Reminder in the bot's reply | Admin checks the **winner only** |
| Comment on giveaway post + tag a friend | Bonus | +1 (max 1) | IG webhook, plus a 10-minute sync of all comments | Bot (comment must @tag someone other than BB or the commenter) |
| Share giveaway post to IG Story + tag @BostonBlerds | Bonus | +1 (max 1) | IG `messages` webhook (`story_mention`) | Bot |
| Attend Retro Gaming Night, ticket scanned | Bonus | +1 (max 1) | Posh event report CSV (**Tickets Scanned** + **Instagram** columns) | Posh |

**Max entries per person: 4.** Every bonus is capped at 1. No eligibility restrictions (no age, location or staff limits). **1 winner** (prize: GTA VI).

> **Instagram limits:** Instagram's API can't tell you whether a user follows you, so follows are checked by hand for the winner only. Comments and Story mentions are automatic (see §6a).

---

## 2. User flow (entrant)

**Entrants see as little as possible.** The bot only ever tells them their username was captured or updated. They never see entry counts, bonuses or anyone else's entries.

1. Sees the IG announcement → joins Discord → goes to `#gta-giveaway`.
2. Runs **`/giveaway enter`**, which opens a form with one field: **Instagram username**. Admins post and pin the rules in the channel themselves.
3. The bot replies **privately**: "✅ Username captured! Don't forget to follow @BostonBlerds on Instagram!"
4. Running it again opens the form pre-filled with their current username, so they can edit it. The reply is "✅ Username updated!". The old value is kept in the audit log.

**Rules enforced by the bot**
- One entry per Discord account.
- One Discord account per IG username. If a second account claims the same username, the bot replies "message an admin" without saying why, and flags it in the audit log.
- IG usernames are cleaned up (strip `@` and instagram.com URLs, lowercase, trim) and must match IG's format (letters, numbers, `.` and `_`, up to 30 characters).
- No entries or changes after **Nov 20, 2026 10:30 PM America/New_York**.
- An entrant must still be in the server at draw time.

---

## 3. Admin flow

**There are no admin commands in Discord.** `/giveaway enter` is the only giveaway command, and it's public. It's limited to `#gta-giveaway` through Discord's own settings (Server Settings → Integrations → BB-BOT → `/giveaway` → Channels), not in code. The older `/playing`, `/activegames` and `/communitycode` stay admin-only (role `admin`).

Recording bonuses (Story shares, IRL), disqualifying entries, viewing and downloading all happen on **admin.bostonblerds.com** (§4). Until that site exists, admins keep a list of Story shares (IG usernames) to enter there later.

**Bonuses for people who haven't entered yet:** a bonus can be recorded for an IG username with no entry. It's stored as *unmatched* and attaches automatically if that person enters before the deadline. Unmatched bonuses never count on their own.

---

## 3a. Posh (IRL bonus)

Posh's **Export Event Report** (Event → Settings → Export event report, delivered by email as a CSV) includes the columns we need: **Order Number**, **Tickets Scanned**, **Instagram** and **Custom Checkout Field**. There's no check-in timestamp, but we don't need one.

**Flow**
1. Add an optional checkout question to the Retro Gaming Night RSVP: *"Entering our GTA VI giveaway? Drop your Instagram username."*
2. After the event, export the report with those columns selected.
3. Upload the CSV on the admin site. Every row with tickets scanned > 0 gets +1 IRL for its IG username. The custom field wins over the profile's Instagram field if they differ.
4. Fallback: an admin records IRL bonuses by hand on the admin site.

The Posh webhook (`new_order`) is **not needed**, because the export covers both the IG username and the scan.

---

## 4. Admin site — admin.bostonblerds.com

A small web app that reads the same database.
- **Auth:** "Sign in with Discord". Access is allowed only to members of the Boston Blerds server who have the `admin` role. This is the only gate.
- **Entrants:** a searchable table with Discord username, IG username, each bonus, total entries, entered date, still-in-server status, and disqualified status.
- **Audit log:** every action, with who did it and when.
- **Downloads:**
  - `wheel.csv`: one row **per entry**, so a person with 3 entries appears 3 times and the wheel is weighted. Columns: `discord_username, discord_id, ig_username, entry_type`
  - `entrants.csv`: one row per person
  - `audit.csv`
- **Posh upload** (§3a).
- **Edit:** record a bonus by hand (Story shares), disqualify or restore an entry. Every change is written to the audit log.

**Until the site exists,** the data is safe in Postgres and can be queried directly on the VM if needed.

**Winner flow (in person, Nov 20):**
1. Upload the Posh report → entries close → download `wheel.csv` → load it into the spinner app.
2. **Disconnect the projector or screen.** Spin privately.
3. Verify that the result follows @BostonBlerds on IG and is still in the Discord. If not, remove them and spin again privately.
4. **Reconnect the screen** and do the public spin.
5. Contact the winner by **Discord DM**. They have **12 hours to claim**. If they don't, draw again.

> 📝 **Spinner app requirement (separate project, don't forget):** the app must support a private "verification spin" with the screen disconnected, then a repeat public spin. It must load `wheel.csv` (weighted, one row per entry). Decide how the public spin relates to the verified result before Nov 20.

---

## 5. Data model (Postgres, implemented in `src/db/schema.ts`)

```
giveaways   id, slug ('gta6-2026'), channel_id, message_id, closes_at, created_at
entrants    id, giveaway_id, discord_id, discord_username, ig_username,
            revoked_at, revoked_by, revoked_reason, created_at, updated_at
            UNIQUE (giveaway_id, discord_id) · UNIQUE (giveaway_id, ig_username)
bonuses     id, giveaway_id, ig_username, type (COMMENT|STORY|IRL),
            source (admin|ig_api|ig_webhook|posh), source_ref, created_by,
            revoked_at, revoked_by, revoked_reason, created_at
            UNIQUE (giveaway_id, ig_username, type)   -- max 1 per bonus
audit_log   id, giveaway_id, actor_id, action, details jsonb, created_at
```

Bonuses are linked by **IG username**, not by entrant. That's what lets unmatched bonuses attach later. It follows the Synapse Phase 1 pattern (Discord identity + audit log), so the data can move into Synapse later.

---

## 6. Infrastructure

- **Host:** Oracle Cloud Always Free, **us-ashburn-1**, Ampere A1 VM (ARM), Ubuntu. Ashburn often runs out of A1 capacity. Fallback: the always-free AMD micro VM (1 GB RAM), which is enough for the bot plus Postgres.
- **Runtime:** Docker Compose with `bot` and `db` (Postgres 18). The admin site becomes a third container. No Redis yet.
- **Public HTTPS:** **Cloudflare Tunnel** (`cloudflared` container) maps `admin.bostonblerds.com` (and later the webhook endpoints) to the VM. The domain is already on Cloudflare, so the VM opens no inbound ports.
- **Backups:** nightly `pg_dump` on the VM, plus a copy off the VM.
- **Secrets:** `.env` on the VM only, never committed.

## 6a. Meta app (done — no App Review needed)

Meta's rules: apps used only for a business you own or manage run on Standard Access and **don't need App Review**. After publishing the app (Live mode), we confirmed on Oct 16, 2026:
- ✅ **Comment webhooks** arrive live and award the comment bonus automatically.
- ✅ **Reading all comments** via the API works, so a 10-minute sync catches anything a webhook missed, retroactively.
- ✅ **Story mentions** arrive as `messages` webhooks with a `story_mention` attachment. The bot looks up the sender's username and awards the Story bonus.

Setup: Meta app "BB-Bot" in the Boston Blerds business portfolio, using Instagram API with Instagram Login. Webhook `https://api.bostonblerds.com/webhooks/instagram`, subscribed to `comments` and `messages`. Only giveaway-post comments and Story mentions are stored; other DMs are dropped.

**Maintenance:** `IG_ACCESS_TOKEN` expires 60 days after it was generated (around Dec 15, 2026). Regenerate it in the Meta dashboard before then if the bot is still needed.

**Before launch:** set `IG_GIVEAWAY_POST` to the giveaway post's link, and wipe the test entries and bonuses.

---

## 7. Delivery plan

| Step | Deliverable |
|---|---|
| **1. Now** | ✅ `/giveaway enter`, form, DB; older commands admin-only |
| **2. Next** | Oracle VM up; bot + DB running 24/7; nightly backups |
| 3 | Launch: pin the rules in `#gta-giveaway`. Start the Meta app and Business Verification. |
| 4 | Cloudflare Tunnel + **admin.bostonblerds.com** with Discord login, entrants table, bonus/disqualify edits and CSV downloads |
| 5 | Posh CSV upload on the admin site (before Nov 20) |
| 6 | IG comment sync, then switch to webhooks on Meta approval |
| Nov 20 | Upload Posh report → close → download `wheel.csv` → spin |

---

## 8. Open questions

1. **Launch date:** Oct 19 with manual Story logging, or wait for Meta approval?
2. **Story logging:** who logs Story shares day to day until Meta approval?

**Decided:** admin role = `admin` · no eligibility restrictions · 1 winner, Discord DM, **12 hours to claim** · every bonus max 1 · entrants only see "captured/updated" · data viewed and downloaded on admin.bostonblerds.com behind Discord admin login · Posh via event-report CSV, no webhook · domain `bostonblerds.com` on Cloudflare · repo `titamah/synapse`.
