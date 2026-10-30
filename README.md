# Getting Started app for Discord

This project contains a Discord learning assistant written in JavaScript, built on the [Discord getting started guide](https://discord.com/developers/docs/getting-started).

![Demo of app](https://github.com/discord/discord-example-app/raw/main/assets/getting-started-demo.gif?raw=true)

## Project structure
Below is a basic overview of the project structure:

```
├── examples    -> short, feature-specific sample apps
│   ├── app.js  -> finished app.js code
│   ├── button.js
│   ├── command.js
│   ├── modal.js
│   ├── selectMenu.js
├── .env.sample -> sample .env file
├── app.js      -> main entrypoint for app
├── commands.js -> slash command payloads + helpers
├── utils.js    -> utility functions and enums
├── package.json
├── README.md
└── .gitignore
```

## Running app locally

Before you start, you'll need to install [NodeJS](https://nodejs.org/en/download/) and [create a Discord app](https://discord.com/developers/applications) with the proper permissions:
- `applications.commands`
- `bot` (with Send Messages enabled)


Configuring the app is covered in detail in the [getting started guide](https://discord.com/developers/docs/getting-started).

### Setup project

First clone the project:
```
git clone https://github.com/discord/discord-example-app.git
```

Then navigate to its directory and install dependencies:
```
cd discord-example-app
npm install
```
### Get app credentials

Fetch the credentials from your app's settings and add them to a `.env` file (see `.env.sample` for an example). You'll need your app ID (`APP_ID`), bot token (`DISCORD_TOKEN`), and public key (`PUBLIC_KEY`).

Fetching credentials is covered in detail in the [getting started guide](https://discord.com/developers/docs/getting-started).

> 🔑 Environment variables can be added to the `.env` file in Glitch or when developing locally, and in the Secrets tab in Replit (the lock icon on the left).

### Configure OpenRouter

Add your OpenRouter API key and the model slug you want to use to `.env` (or your hosting provider's secrets):

```env
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=provider/model
# Optional; timezone for OpenRouter's datetime tool (defaults to New York).
OPENROUTER_DATETIME_TIMEZONE=America/New_York
# Optional; override the model used by /study.
OPENROUTER_STUDY_MODEL=provider/instruct-model
```

The bot uses `OPENROUTER_MODEL` for `/ask` and `/research`. `/study` uses `OPENROUTER_STUDY_MODEL` when set and otherwise falls back to `OPENROUTER_MODEL`; choosing an instruction-following model can avoid reasoning-heavy models spending the output budget before producing study notes. If a model exhausts the output limit without producing visible text, the bot retries that request once with reasoning disabled. `/research` additionally enables OpenRouter's `openrouter:web_search` tool and asks for direct source links. Each invocation is a separate request; the bot does not retain conversation history.

`/agent` opens a private **Agent Center** instead of exposing a long list of slash-command fields. **Run agent** provides the shortest path: choose an agent and its task form opens immediately. The separate Create and Browse buttons remain available for building agents, viewing their details, and managing agents created by the current student. Create and Edit use a short profile form followed by a preview where web research, study-file analysis, output format, and language can be adjusted before saving. Test privately exercises an agent owned by the caller, and edits increment the displayed configuration version.

Every saved agent is discoverable and runnable by anyone who uses the bot, including from another server or a DM. Agent names are globally unique and case-insensitive: `Lakshmi` and `lakshmi` are the same name, and creation or renaming fails with a clear message when a name is already taken. Only the creator can edit, delete, or privately test an agent. **Run an agent** posts the result publicly in a server channel so the invocation and answer remain part of the channel history. Agent creation, configuration, listing, and Test responses remain private.

Agents use the bot's configured `OPENROUTER_MODEL`; students cannot provide model IDs, arbitrary tools, code, database access, or secrets. Every agent can use OpenRouter's `openrouter:datetime` tool; web-enabled agents also receive `openrouter:web_search`. File-enabled agents reuse the existing one-run attachment processing, and text files are sent as ordinary text for broad model compatibility. An agent can enable both tools. Agent output budgets are 1,000 tokens for concise, 4,000 for detailed or report output, and 2,500 for every other format. File-based runs and balanced or concise output disable model reasoning so the answer receives the output budget; non-file detailed and report runs use low reasoning effort. Recovery and continuation requests also disable reasoning. When OpenRouter still ends a non-empty response because of length, the bot makes at most two continuation requests, joins the completed lines, and labels the result if it remains incomplete. Short answers appear directly in Discord; long answers show a completion title and attach the complete response as a Markdown file, avoiding temporary pagination state. Runs remain stateless and are limited to 5 requests per user per minute and 30 per minute across this bot process. Agent provider routing defaults to `data_collection: deny`; set `OPENROUTER_AGENT_DATA_COLLECTION=allow` only after reviewing the selected provider's retention and training policies. Agent profiles persist in Oracle; uploaded files and conversations are not saved by the agent feature.

The `Query schema data` action under `/db` maps a natural-language question to a read-only query plan. The bot automatically builds its catalog from every supported column in every table and view owned by `ADB_CATALOG_OWNER` (default: `ADB_USER`); model-generated SQL is never executed. Query results are formatted by the bot and are not sent back to OpenRouter. The question and semantic query catalog are sent to OpenRouter with data-collection endpoints denied; this request does not require ZDR. Because all supported columns are auto-approved, results may contain sensitive information. In server channels, every `/db` action and its result are posted publicly. The bot requires `ADB_USER`, `ADB_PASSWORD`, `ADB_CONNECT_STRING`, `ADB_WALLET_DIR`, and `ADB_WALLET_PASSWORD`. The command is registered only for Discord servers, but it does not apply an additional guild, role, Administrator, or Manage Server check. Writes and arbitrary SQL are not supported.

The ADB connection uses the downloaded wallet with node-oracledb Thin mode. Oracle Instant Client is not required by this connection path. Extract the wallet into a directory readable only by the service account. Thin mode uses `tnsnames.ora` to resolve the service alias and `ewallet.pem` for mTLS; `ADB_WALLET_PASSWORD` is the password created when the wallet was downloaded. See [node-oracledb's ADB wallet instructions](https://node-oracledb.readthedocs.io/en/latest/user_guide/connection_handling.html#mutual-tls-connections-to-oracle-cloud-autonomous-database).

Set the values on the bot host, not in Discord or source control. Keep the extracted wallet and its ZIP file out of Git. `ADB_CONNECT_STRING` is a service alias from the wallet's `tnsnames.ora`; the low service is appropriate for this bot's small read-only queries.

Configure the ADB environment values on the server. The guild and role restrictions are optional; role IDs are comma-separated if you allow multiple roles:

```env
ADB_USER=BOT_READONLY
ADB_PASSWORD=<database-user-password>
ADB_CONNECT_STRING=discordadb_low
ADB_WALLET_DIR=/home/opc/discord-example-app/wallet
ADB_WALLET_PASSWORD=<wallet-download-password>
ADB_CATALOG_OWNER=<schema-to-scan>
```

Use a dedicated ADB account with `SELECT` access only to the intended objects for this bot. The database connection uses a small pool with per-query timeouts. The `Check the bot connection to ADB` action under `/db` performs a restricted `SELECT 1 FROM DUAL` connection check and returns only success or failure.

Agent profiles use a separate database pool. For the simplest development setup, omit `AGENT_STORE_USER` and `AGENT_STORE_PASSWORD`; the bot will reuse `ADB_USER` and `ADB_PASSWORD`. When `AGENT_STORE_OWNER` is blank, it defaults to `ADB_USER`, even if dedicated agent-store credentials are configured. That database user must own `AGENT_PROFILES`, while a different runtime user needs the required table grants.

For production, a separate runtime user remains recommended so the `/db` account can stay read-only. Configure it with access only to the profile table, using the same wallet and connect string:

```env
AGENT_STORE_USER=BOT_AGENT_APP
AGENT_STORE_PASSWORD=<agent-store-runtime-password>
AGENT_STORE_OWNER=BOT_AGENT_OWNER
```

Connect as `AGENT_STORE_OWNER` and run the unified [`db/agent-store-schema.sql`](db/agent-store-schema.sql). It can be run against an empty owner schema to create the complete table, or against an older `AGENT_PROFILES` table to add missing agent-builder fields and enforce globally unique names without deleting existing agents. The script is retry-safe, but back up an existing production table before applying any schema change. Then grant only the table operations required by the bot to the runtime account:

```sql
@db/agent-store-schema.sql
```

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON AGENT_PROFILES TO BOT_AGENT_APP;
```

`AGENT_STORE_OWNER` is the schema that owns `AGENT_PROFILES`; it must be an unquoted Oracle schema name. The bot uses fixed SQL statements and binds student values. `/agent` stays unavailable until the runtime credentials, table, and grants are configured. The bot stores at most 20 profiles per Discord user. Every profile is available for any bot user to browse and run; ownership controls only edit, delete, and Test access.

If the schema upgrader reports duplicate agent names, inspect the collisions before renaming them, then rerun the same script:

```sql
SELECT UPPER(NAME) AS NORMALIZED_NAME,
       LISTAGG(OWNER_USER_ID || ':' || NAME, ', ')
         WITHIN GROUP (ORDER BY OWNER_USER_ID) AS AGENTS
  FROM AGENT_PROFILES
 GROUP BY UPPER(NAME)
HAVING COUNT(*) > 1;
```

The `Discover schema tables and views for the approved catalog` action under `/db` reads Oracle metadata for every table and view owned by `ADB_CATALOG_OWNER` (default: `ADB_USER`), auto-approves all supported columns in the runtime catalog, and reports the result. It does not read table rows or modify the database. The `Query schema data` action refreshes the automatic catalog when needed, so running the scan first is optional.

The runtime catalog permits lists, counts, filtering, sorting, grouping, sums, and averages where compatible with the Oracle column type. Responses remain limited to 25 rows, queries use bind variables, and only `SELECT` statements pass the database execution guard. Automatic approval deliberately does not distinguish sensitive application data from other supported columns.

Select `/study`, then choose **Guide** or **Exam** in the `action` option. Both activities accept `input`, `file`, or both; at least one is required. Exams always contain exactly five questions. Study files can be PDF, TXT, Markdown, CSV, or JSON, up to 8 MB.

| Activity | What to provide | Example |
| --- | --- | --- |
| Guide: Create a study guide | A topic in input, a file, or both; at least one is required | input: SQL joins for beginners, with examples |
| Exam: Practice with an interactive quiz | A topic in input, a file, or both; exactly five questions | input: Cell biology, or file: class-notes.pdf |

An exam presents one multiple-choice question at a time with answer buttons, explains each answer, shows a final score, and lets the user review missed questions. Quiz state is private and held in memory for 30 minutes; it is lost if the bot restarts, and scores are not saved. A guide uses OpenRouter web search for source links and returns the full AI answer as a downloadable Markdown file. The bot downloads study files only to process that request and does not keep them for later requests; attach them again when requesting a guide or exam. PDF parsing uses OpenRouter's `cloudflare-ai` parser. File contents are sent to OpenRouter for processing.

### Install slash commands

The commands for the example app are set up in `commands.js`. All of the commands in the `ALL_COMMANDS` array at the bottom of `commands.js` will be installed when you run the `register` command configured in `package.json`:

```
npm run register
```

In server channels, learning command responses and all `/db` action responses post publicly. **Run** from the Agent Center also posts publicly, regardless of who created the globally available agent. Agent creation, browsing, management, and private Test interactions remain ephemeral. Commands used in DMs retain their existing response visibility behavior.

Run registration after adding or changing commands, then restart `discord-example.service`. Registering this version is required to remove the old `/agent` fields and make the command open the Agent Center directly. Run the unified agent-store schema script before restarting this version against an empty or older profile schema. The `/db` action selector offers a connection check, an administrator catalog scan, and a query action. `/agent` becomes usable after the profile table and separate runtime credentials are configured.

### Run the app

After your credentials are added, go ahead and run the app:

```
node app.js
```

> ⚙️ A package [like `nodemon`](https://github.com/remy/nodemon), which watches for local changes and restarts your app, may be helpful while locally developing.

If you aren't following the [getting started guide](https://discord.com/developers/docs/getting-started), you can move the contents of `examples/app.js` (the finished `app.js` file) to the top-level `app.js`.

### Set up interactivity

The project needs a public endpoint where Discord can send requests. To develop and test locally, you can use something like [`ngrok`](https://ngrok.com/) to tunnel HTTP traffic.

Install ngrok if you haven't already, then start listening on port `3000`:

```
ngrok http 3000
```

You should see your connection open:

```
Tunnel Status                 online
Version                       2.0/2.0
Web Interface                 http://127.0.0.1:4040
Forwarding                    https://1234-someurl.ngrok.io -> localhost:3000

Connections                  ttl     opn     rt1     rt5     p50     p90
                              0       0       0.00    0.00    0.00    0.00
```

Copy the forwarding address that starts with `https`, in this case `https://1234-someurl.ngrok.io`, then go to your [app's settings](https://discord.com/developers/applications).

On the **General Information** tab, there will be an **Interactions Endpoint URL**. Paste your ngrok address there, and append `/interactions` to it (`https://1234-someurl.ngrok.io/interactions` in the example).

Click **Save Changes**, and your app should be ready to run 🚀

## Other resources
- Read **[the documentation](https://discord.com/developers/docs/intro)** for in-depth information about API features.
- Browse the `examples/` folder in this project for smaller, feature-specific code examples
- Join the **[Discord Developers server](https://discord.gg/discord-developers)** to ask questions about the API, attend events hosted by the Discord API team, and interact with other devs.
- Check out **[community resources](https://discord.com/developers/docs/topics/community-resources#community-resources)** for language-specific tools maintained by community members.
