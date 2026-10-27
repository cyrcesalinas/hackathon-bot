# Getting Started app for Discord

This project contains a basic rock-paper-scissors-style Discord app written in JavaScript, built for the [getting started guide](https://discord.com/developers/docs/getting-started).

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
├── game.js     -> logic specific to RPS
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
```

The bot uses the configured OpenRouter model for `/ask`, `/research`, and the `/study` subcommands. `/research` enables OpenRouter's `openrouter:web_search` tool and asks for direct source links. Each invocation is a separate request; the bot does not retain conversation history.

`/agent create` lets a student define a private agent with a name, goal, response style, and one approved capability: chat, study help, or web research. The bot shows a preview and saves the profile only after the student confirms. `/agent list`, `/agent run`, `/agent edit`, and `/agent delete` manage those profiles. Agents use the same `OPENROUTER_MODEL` configured for the bot; students cannot supply model IDs or tool definitions. Research agents receive OpenRouter's `openrouter:web_search` server tool, study agents reuse the existing one-run attachment processing, and chat agents receive no tools. Agent runs are stateless, limited to 5 requests per user per minute and 30 per minute across this bot process, and use OpenRouter provider routing with `data_collection: deny`. Agent profiles persist in a dedicated Oracle table; uploaded files and conversations are not saved by the agent feature.

`/dev ask` gives implementation guidance. You can attach one optional Markdown, text, or source-code file to provide project context (1 MB maximum). The bot reads only that direct Discord attachment in memory for the request, rejects redirects and non-Discord download hosts, and does not retain the file. The question and file text are sent to OpenRouter with provider routing set to deny data-collecting endpoints. The request does not require a zero-data-retention endpoint. The command does not edit project files, run code, or access a database. For project-specific answers, attach the relevant README or source file; without an attachment, the answer is general guidance.

`/db lookup` maps a natural-language question to a read-only query plan. It only executes plans that match the explicitly approved datasets and columns in `db/catalog.js`; model-generated SQL is never executed. Query results are formatted by the bot and are not sent back to OpenRouter. The question and semantic query catalog are sent to OpenRouter with data-collection endpoints denied; this request does not require ZDR, so users should not include secrets or sensitive identifiers in their question. The bot requires `ADB_USER`, `ADB_PASSWORD`, `ADB_CONNECT_STRING`, `ADB_WALLET_DIR`, and `ADB_WALLET_PASSWORD`. The command is registered only for Discord servers and always replies ephemerally. `ADB_ALLOWED_GUILD_ID` and `ADB_ALLOWED_ROLE_IDS` are optional access restrictions. If both are blank, only members with Administrator or Manage Server permission can use `/db`. Setting a guild ID with no role IDs allows members of that one guild; setting role IDs requires one of those roles. The initial query catalog is empty until the project owner adds approved ADB views and fields. Writes and arbitrary SQL are not supported.

The ADB connection uses the downloaded wallet with node-oracledb Thin mode. Oracle Instant Client is not required by this connection path. Extract the wallet into a directory readable only by the service account. Thin mode uses `tnsnames.ora` to resolve the service alias and `ewallet.pem` for mTLS; `ADB_WALLET_PASSWORD` is the password created when the wallet was downloaded. See [node-oracledb's ADB wallet instructions](https://node-oracledb.readthedocs.io/en/latest/user_guide/connection_handling.html#mutual-tls-connections-to-oracle-cloud-autonomous-database).

Set the values on the bot host, not in Discord or source control. Keep the extracted wallet and its ZIP file out of Git. `ADB_CONNECT_STRING` is a service alias from the wallet's `tnsnames.ora`; the low service is appropriate for this bot's small read-only queries.

Configure the ADB environment values on the server. The guild and role restrictions are optional; role IDs are comma-separated if you allow multiple roles:

```env
ADB_USER=BOT_READONLY
ADB_PASSWORD=<database-user-password>
ADB_CONNECT_STRING=discordadb_low
ADB_WALLET_DIR=/home/opc/discord-example-app/wallet
ADB_WALLET_PASSWORD=<wallet-download-password>
ADB_CATALOG_OWNER=<approved-view-owner>
ADB_CATALOG_PREFIX=BOT_
ADB_ALLOWED_GUILD_ID=
ADB_ALLOWED_ROLE_IDS=
```

Use a dedicated ADB account with `SELECT` access only to curated views for this bot. The database connection uses a small pool with per-query timeouts. `/db status` performs a restricted `SELECT 1 FROM DUAL` connection check and returns only success or failure. It uses whichever guild and role restrictions are configured.

Agent profiles use a separate database connection so the read-only `/db` account does not receive write privileges. Configure a runtime user with access only to the profile table, using the same wallet and connect string:

```env
AGENT_STORE_USER=BOT_AGENT_APP
AGENT_STORE_PASSWORD=<agent-store-runtime-password>
AGENT_STORE_OWNER=BOT_AGENT_OWNER
```

Connect as `AGENT_STORE_OWNER` and run [`db/agent-store-schema.sql`](db/agent-store-schema.sql). Then grant only the table operations required by the bot to the runtime account:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON AGENT_PROFILES TO BOT_AGENT_APP;
```

`AGENT_STORE_OWNER` is the schema that owns `AGENT_PROFILES`; it must be an unquoted Oracle schema name. The bot uses fixed SQL statements and binds student values. `/agent` stays unavailable until the runtime credentials, table, and grants are configured. The bot stores at most 20 profiles per Discord user. Profiles are owner-private; sharing is not enabled.

`/db scan` is restricted to members with Administrator or Manage Server permission. It reads Oracle metadata for accessible views under `ADB_CATALOG_OWNER` (default: `ADB_USER`) whose names start with `ADB_CATALOG_PREFIX` (default: `BOT_`). It reports matching views and compatible column types ephemerally. A scan never modifies the database or activates a view; pending candidates must still be reviewed and added to `db/catalog.js`.

Each catalog entry in `db/catalog.js` defines one approved view and its user-facing columns, filter operators, grouping, and aggregation permissions. Add only fields that are safe to return in Discord. The query planner only sees this semantic catalog; SQL object names remain in the bot configuration.

`/study guide` accepts a topic, a file, or both. `/study upload` analyzes an attached file and returns study notes immediately. Study files can be PDF, TXT, Markdown, CSV, or JSON, up to 8 MB. The bot downloads a file only to process that command and does not keep it for later commands; attach it again when requesting a guide. PDF parsing uses OpenRouter's `cloudflare-ai` parser. File contents are sent to OpenRouter for processing.

### Install slash commands

The commands for the example app are set up in `commands.js`. All of the commands in the `ALL_COMMANDS` array at the bottom of `commands.js` will be installed when you run the `register` command configured in `package.json`:

```
npm run register
```

In server channels, the app posts only its command response; it does not create a separate message containing the command inputs. Replies that would otherwise be ephemeral are made public. Commands used in DMs retain their existing visibility behavior.

Run registration after adding or changing commands, then restart `discord-example.service`. `/db status` checks connectivity without returning database contents. `/db scan` discovers scoped candidate views without activating them. `/db lookup` becomes usable after the ADB environment and approved catalog are configured. `/agent` becomes usable after the profile table and separate runtime credentials are configured.

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
