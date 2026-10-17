# Synapse

Synapse is an open-source platform originally designed for Boston Blerds, created for building and operating online communities, combining moderation tools, engagement systems, and analytics with a strong emphasis on consent, security, and user experience.

**BB-Bot** is Synapse's Discord interface: the bot members interact with.

Current focus: the [GTA VI giveaway](docs/gta-giveaway-spec.md).

## Stack

Node.js + TypeScript · discord.js · Postgres + Drizzle · Docker Compose

## Local development

**Prerequisites:** [Docker Desktop](https://www.docker.com/products/docker-desktop/), Node 22+

1. Clone and install:
   ```bash
   git clone https://github.com/titamah/synapse.git
   cd synapse
   npm install
   ```
2. Create your environment file and fill in the Discord and Postgres values:
   ```bash
   cp .env.example .env
   ```
3. Start the bot and database:
   ```bash
   docker compose up --build
   ```
   On boot the bot runs database migrations and registers its slash commands with your server.

> Only one copy of the bot can run per Discord token. For local development, use the separate **BB-Bot Dev** app:
> put its token in `.env.dev` (gitignored), start the database with `docker compose up -d db`, then run `npm run dev`.

### Database changes

Edit `src/db/schema.ts`, then generate a migration and commit it:
```bash
npm run db:generate
```
Migrations in `drizzle/` are applied automatically on startup.

## Production

Runs on an Oracle Cloud Always Free VM (Ubuntu 24.04) with Docker Compose, from a clone of this repo at `~/synapse`. Secrets live only in `~/synapse/.env` on the server.

**Deploy** (after merging to `main`):
```bash
ssh synapse "cd ~/synapse && git pull && docker compose up -d --build"
```

**Logs:**
```bash
ssh synapse "cd ~/synapse && docker compose logs bot --tail 50"
```

**Backups:** `scripts/backup.sh` runs nightly at 3 AM ET via cron and keeps 14 days of compressed dumps in `~/backups`.
