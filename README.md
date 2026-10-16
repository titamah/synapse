# BOLT

Bolt is an open-source platform originally designed for Boston Blerds, created for building and operating online communities, combining moderation tools, engagement systems, and analytics with a strong emphasis on consent, security, and user experience.

## Setup

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed

### Getting Started

1. **Clone the repository:**
   ```bash
   git clone https://github.com/titamah/bb-bot.git
   cd bb-bot
   ```

2. **Create your environment file:**
   ```bash
   cp .env.example .env
   ```

3. **Update `.env` with your own values:**
   - `POSTGRES_USER` - PostgreSQL username (default: `postgres`)
   - `POSTGRES_PASSWORD` - Your secure database password
   - `POSTGRES_DB` - Database name (default: `example`)
   - `SERVER_PORT` - Server port (default: `5000`)
   - `NODE_ENV` - Environment mode (default: `development`)

4. **Start the application:**
   ```bash
   docker compose up
   ```

   The bot will be running on http://localhost:5000 (or the port specified in `SERVER_PORT`) and connected to a local PostgreSQL database.

5. **To stop the application:**
   ```bash
   docker compose down
   ```

## Development

Make changes to your code and restart with `docker compose up`. 

To rebuild after changes to dependencies:
```bash
docker compose up --build
```
