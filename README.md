# AI Student Circle Discord Bot

A Discord learning assistant powered by OpenRouter and Oracle Autonomous Database. It supports direct questions, cited web research, study guides and quizzes, Oracle Cloud learning, read-only database questions, reusable student-created agents, and replies to bot mentions.

## Commands

| Command | Purpose |
| --- | --- |
| `/ask` | Explain a question or concept. |
| `/research` | Research a topic with web search and source links. |
| `/study` | Build a study guide or take a five-question quiz from a topic or attached file. |
| `/oci` | Learn about Compute, Networking, IAM, Object Storage, Kubernetes, GoldenGate, OCI Generative AI, serverless, streaming, observability, and security. |
| `/ai-db` | Learn about Oracle AI Database, AI Vector Search and RAG, Select AI, Autonomous AI Lakehouse, and Deep Trust AI Architecture. |
| `/db` | Check the Oracle connection, discover the approved catalog, or query approved schema data. |
| `/agent` | Create, browse, test, edit, delete, and run reusable learning agents. |
| `/memory` | Privately list, delete, or clear your own notes in the current channel. |

Long `/research` reports use up to two bounded continuation requests. Before publishing, the bot checks that the report finishes cleanly, contains a Sources section with direct Markdown links, and does not expose internal tool-call tags. An invalid report is regenerated once in a shorter form; if that repair still fails, the bot reports the problem instead of attaching incomplete research as a completed response.

`/study` guides are generated in bounded output chunks with hidden reasoning disabled, then validated before attachment. If a guide is missing required sections, direct source links, or complete Markdown, the bot logs only the validation labels and regenerates it once with those issues and a fresh bounded deadline. The repair keeps the original topic and research tools but disables memory writes so it cannot duplicate personal notes.

The bot also answers server messages that mention it. Agent runs and follow-up replies are rate limited and keep their continuation context in memory for one hour.

## Requirements

- Node.js 24.x
- npm 11.x (the repository records the tested npm version in `package.json`)
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
OPENROUTER_DATETIME_TIMEZONE=America/New_York
```

The datetime timezone is optional. Agent requests deny providers that collect data.

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

Agent profiles use `ADB_USER` and `ADB_PASSWORD`, the same database credentials as the rest of the bot. `AGENT_STORE_OWNER` is an optional schema name if `AGENT_PROFILES` lives in a different schema; it defaults to `ADB_USER`.

```env
AGENT_STORE_OWNER=BOT_AGENT_OWNER
```

Connect as the schema owner and apply the retry-safe schema script. When the schema owner differs from `ADB_USER`, grant the app account access to the table:

```sql
@db/agent-store-schema.sql
GRANT SELECT, INSERT, UPDATE, DELETE ON AGENT_PROFILES TO BOT_READONLY;
```

Replace `BOT_READONLY` with the value configured in `ADB_USER` if it differs.

The schema script creates a new `AGENT_PROFILES` table or upgrades an older one in place. Back up an existing production table before applying schema changes.

Agent profiles are globally discoverable. Only the creator can edit, delete, or privately test an agent. Uploaded files and conversation text are not stored permanently by the agent feature.

### Personal memory in ADB

Memory automatically reads `about_person` notes for every eligible request, including generic questions, and includes them as dated untrusted context before the model answers. OpenRouter client function tools remain available in the same request: the selected model can call `remember(note)` or refresh `about_person()` with `tool_choice: auto`; the app validates and executes each call, then returns its result in the same tool-calling loop. The selected model must support function tools together with the request's formatting and file inputs. There is no memory enable flag or dedicated memory model setting. A tool-free validation request checks a proposed note before saving, using the model selected for the original request. Existing web-search and datetime tools remain available alongside memory tools.

Install the schema **as its owner** using the configured wallet and credentials:

```sh
npm run memory:setup
npm run memory:check
# Optional: uses the configured models and a synthetic user for real tool calls.
npm run memory:agent-check
```

The first command applies `db/person-notes-schema.sql` without dropping data. The second creates synthetic notes, checks concurrent deduplication and isolation, deletes its test notes, and checks that `/db` cannot discover the tables. It requires the same runtime privileges as the app. Small scope revision tombstones remain to prevent delayed writes from undoing deletion.

If the memory schema owner differs from `ADB_USER`, connect as the schema owner for setup, then grant the app account these permissions. The bot continues to connect as `ADB_USER`:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON PERSON_NOTES TO BOT_READONLY;
GRANT SELECT, INSERT, UPDATE, DELETE ON PERSON_NOTE_SCOPES TO BOT_READONLY;
```

Replace `BOT_READONLY` with the value configured in `ADB_USER` if it differs.

Do not grant memory-table access to the `/db` account. The app also excludes memory tables from metadata discovery, query-plan validation, and SQL execution. Existing views or synonyms that expose private tables must not be granted to the `/db` account.

`USER_MEMORY_OWNER` can name a different schema for the memory tables; it defaults to `AGENT_STORE_OWNER` and then `ADB_USER`. The bot uses `ADB_USER` and `ADB_PASSWORD` for both agent profiles and personal memory. Configure any required grants and register the `/memory` command before restarting the bot. Memory tools are included automatically when an eligible Discord request has a valid memory context and the store is available.

Each `PERSON_NOTES` row stores its ID, Discord user, guild (`@dm` for private conversations), exact channel, note, source message/interaction ID, source type, and Oracle timestamp. Discord IDs remain strings. `remember` accepts **only** a note: all identity and provenance fields come from the Discord event, never from the model. Individual DMs and group DMs stay separate because their channel IDs differ. Notes never cross channels, servers, or users.

The original typed inputs to `/ask`, `/research`, `/study`, `/oci`, `/ai-db`, `/agent` runs/tests, bot mentions and agent follow-ups are eligible. Files, profiles, earlier assistant answers, quiz clicks, `/db` planning and web results are excluded as evidence. The model saves durable direct self-disclosures automatically when useful. Each note must start with `The user`, `This user`, `La persona`, `El usuario` or `La usuaria`, in third person and at most **499 Unicode code points**. Conservative source checks reject secrets, quotations, third-party attribution and inputs without a self-disclosure. A separate tool-free validation request checks grounding, durability, third person and safety before a write. Its JSON verdict is parsed strictly by the server, so provider JSON-mode support is optional. Ambiguous inputs can therefore be intentionally skipped; these checks do not guarantee perfect semantic classification.

`about_person()` reads the **latest 40 notes**, ordered by creation time and ID. The server performs this read before every eligible answer, so relevant preferences also apply to generic questions without depending on a voluntary model tool call. The complete history remains until deleted; older notes are not retrieved by this tool. Retries of the same normalized note from the same source message or interaction are not reinserted. A later self-disclosure can reaffirm an older preference while preserving the order of corrections. Notes are dated data, never instructions; a newer explicit correction takes precedence. Use `/memory action:list` to inspect notes, `/memory action:delete id:...` to delete an outdated note, or `/memory action:clear` to erase all your notes **in the current channel**. These operations and attached exports are private. Other users cannot manage your notes.

There are at most two write attempts per turn, four tool rounds and eight tool executions with a shared deadline. Formatting repairs and response continuations cannot repeat memory effects. Writes hold a scope lock; deletion changes its revision so a pending request cannot recreate forgotten notes. Commit failures report an uncertain outcome rather than a successful save. If memory is unavailable, the app answers without memory tools. Requests carrying memory use `provider.data_collection: deny` and `require_parameters: true`, including the validation request. The live agent check verifies a real save function call and automatic recall on a generic follow-up rather than relying only on advertised model capabilities. These options are not a guarantee of zero retention by every service. Logs omit note contents and provider error bodies.

OpenRouter reference: [Client tools and tool calling](https://openrouter.ai/docs/guides/features/tool-calling).

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

The included GitHub Actions workflow runs the full test suite, connects to the configured OCI host, installs production dependencies, registers commands, and restarts `discord-example.service`. Configure these repository values before enabling it:

- Variable: `DEPLOY_HOST`
- Variable: `DEPLOY_USER`
- Secret: `DEPLOY_SSH_KEY`
- Secret: `DEPLOY_KNOWN_HOSTS`

The remote workflow expects a Git checkout at `/home/opc/hackathon-bot` and Node.js/npm installed under `/usr/local/bin`. The service is expected to be named `discord-example.service`.

## Data handling

- `/ask`, `/research`, `/study`, `/oci`, `/ai-db`, and agent prompts send request content to OpenRouter.
- Study and agent attachments are processed for the current request and are not saved by this repository.
- Agent profiles and enabled personal memory persist in Oracle; conversation continuations and quiz state stay in process memory and disappear on restart.
- `/db` sends the user's question and schema catalog to OpenRouter, then validates and executes a read-only query plan locally. Database rows are not sent back to OpenRouter.
- Learning command responses, `/db` responses, and normal agent runs are public in server channels. Agent setup, management, and private tests use ephemeral responses.

## Maintenance

```sh
npm test
```

The project uses npm and commits `package-lock.json`. Keep command definitions in `commands.js` aligned with the interaction handlers in `app.js`.
