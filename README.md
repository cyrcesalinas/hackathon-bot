# AI Student Circle Discord Bot

A Discord learning assistant powered by OpenRouter and Oracle Autonomous Database. It supports direct questions, cited web research, study guides and quizzes, Oracle Cloud learning, read-only database questions, reusable student-created agents, and replies to bot mentions.

## Commands

| Command | Purpose |
| --- | --- |
| `/ask` | Explain a question or concept. |
| `/research` | Research a topic with web search and source links. |
| `/study` | Build a study guide or take a five-question quiz from a topic or attached file. |
| `/oci` | Learn about the supported Oracle Cloud and AI topics. |
| `/db` | Check the Oracle connection, discover the approved catalog, or query approved schema data. |
| `/agent` | Create, browse, test, edit, delete, and run reusable learning agents. |

The bot also answers server messages that mention it. Agent runs and follow-up replies are rate limited and keep their continuation context in memory for one hour.

## Requirements

- Node.js 18 or newer
- A Discord application and bot token
- An OpenRouter API key and model
- Oracle Autonomous Database credentials and a wallet for `/db` and persistent agents

Oracle is optional at startup. Features that require an unconfigured service return an availability message instead of stopping the bot.

## Install

```sh
git clone https://github.com/cyrcesalinas/hackathon-bot.git
cd hackathon-bot
npm ci
cp .env.sample .env
```

Fill in `.env` with the credentials for the features you plan to use. Do not commit this file, an Oracle wallet, or wallet archives.

## Configuration

### Discord

```env
APP_ID=your_application_id
DISCORD_TOKEN=your_bot_token
PUBLIC_KEY=your_application_public_key
PORT=3000
```

In the Discord Developer Portal:

1. Add the `applications.commands` and `bot` scopes to the application install.
2. Give the bot permission to view channels, send messages, read message history, and attach files.
3. Set the Interactions Endpoint URL to the public HTTPS URL of the server followed by `/interactions`.

For local development, expose the configured port with a tunnel such as ngrok.

### OpenRouter

```env
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=provider/model
OPENROUTER_STUDY_MODEL=provider/instruct-model
OPENROUTER_DATETIME_TIMEZONE=America/New_York
OPENROUTER_AGENT_DATA_COLLECTION=deny
```

`OPENROUTER_STUDY_MODEL` is optional and falls back to `OPENROUTER_MODEL`. The datetime timezone is also optional. Agent requests deny providers that collect data by default; set `OPENROUTER_AGENT_DATA_COLLECTION=allow` only after reviewing the selected provider's retention and training policy.

### Oracle Autonomous Database

```env
ADB_USER=BOT_READONLY
ADB_PASSWORD=your_database_password
ADB_CONNECT_STRING=discordadb_low
ADB_WALLET_DIR=/absolute/path/to/wallet
ADB_WALLET_PASSWORD=your_wallet_password
ADB_CATALOG_OWNER=YOUR_SCHEMA
```

Use a dedicated account with `SELECT` access only to the tables and views the bot may expose. `/db` builds a runtime catalog from supported columns owned by `ADB_CATALOG_OWNER`, which defaults to `ADB_USER`. It never executes model-generated SQL, but query results can still contain sensitive data and are public when used in a server channel.

The connection uses node-oracledb Thin mode with `tnsnames.ora` and `ewallet.pem`; Oracle Instant Client is not required.

### Agent profile storage

For development, agent profiles can reuse `ADB_USER` and `ADB_PASSWORD`. For production, use a separate runtime account:

```env
AGENT_STORE_USER=BOT_AGENT_APP
AGENT_STORE_PASSWORD=your_agent_store_password
AGENT_STORE_OWNER=BOT_AGENT_OWNER
```

Connect as `AGENT_STORE_OWNER` and apply the retry-safe schema script:

```sql
@db/agent-store-schema.sql
GRANT SELECT, INSERT, UPDATE, DELETE ON AGENT_PROFILES TO BOT_AGENT_APP;
```

The schema script creates a new `AGENT_PROFILES` table or upgrades an older one in place. Back up an existing production table before applying schema changes.

Agent profiles are globally discoverable. Only the creator can edit, delete, or privately test an agent. Uploaded files and conversation text are not stored permanently by the agent feature.

## Register and run

Register the slash commands after configuring Discord credentials:

```sh
npm run register
```

Start the bot:

```sh
npm start
```

For development with automatic restarts:

```sh
npm run dev
```

Command registration installs the current commands and removes the known legacy `/agents`, `/challenge`, `/test`, and `/dev` commands.

## Deployment

The included GitHub Actions workflow connects to the configured OCI host, runs `npm ci --omit=dev`, registers commands, and restarts `discord-example.service`. Configure these repository values before enabling it:

- Variable: `DEPLOY_HOST`
- Variable: `DEPLOY_USER`
- Secret: `DEPLOY_SSH_KEY`
- Secret: `DEPLOY_KNOWN_HOSTS`

The remote workflow currently expects the checkout at `/home/opc/discord-example-app`. Update the workflow and the `deploy` script together if your service or installation uses different names.

## Data handling

- `/ask`, `/research`, `/study`, `/oci`, and agent prompts send request content to OpenRouter.
- Study and agent attachments are processed for the current request and are not saved by this repository.
- Agent profiles persist in Oracle; conversation continuations and quiz state stay in process memory and disappear on restart.
- `/db` sends the user's question and schema catalog to OpenRouter, then validates and executes a read-only query plan locally. Database rows are not sent back to OpenRouter.
- Learning command responses, `/db` responses, and normal agent runs are public in server channels. Agent setup, management, and private tests use ephemeral responses.

## Maintenance

```sh
npm test
```

The project uses npm and commits `package-lock.json`. Keep command definitions in `commands.js` aligned with the interaction handlers in `app.js`.
