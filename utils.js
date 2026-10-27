import 'dotenv/config';

const MAX_RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BUFFER_MS = 150;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function DiscordRequest(endpoint, options) {
  // append endpoint to root API URL
  const url = 'https://discord.com/api/v10/' + endpoint;
  const requestOptions = { ...options };
  if (requestOptions.body && typeof requestOptions.body !== 'string') {
    requestOptions.body = JSON.stringify(requestOptions.body);
  }

  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'User-Agent': 'DiscordBot (https://github.com/discord/discord-example-app, 1.0.0)',
      },
      ...requestOptions,
    });

    if (res.ok) return res;

    const responseText = await res.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      data = { message: responseText || res.statusText };
    }

    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const bodyRetryAfter = data && typeof data === 'object' ? data.retry_after : undefined;
      const retryAfter = Number(bodyRetryAfter ?? res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter >= 0) {
        await wait(retryAfter * 1000 + RATE_LIMIT_BUFFER_MS);
        continue;
      }
    }

    console.log(res.status);
    throw new Error(JSON.stringify(data));
  }
}

export async function InstallGlobalCommands(appId, commands) {
  // Create or update these commands without deleting other commands on the app.
  const endpoint = `applications/${appId}/commands`;
  const installedCommands = [];

  for (const command of commands) {
    const response = await DiscordRequest(endpoint, {
      method: 'POST',
      body: command,
    });
    installedCommands.push(await response.json());
  }

  return installedCommands;
}

export async function RemoveGlobalCommands(appId, commandNames) {
  const endpoint = `applications/${appId}/commands`;
  const response = await DiscordRequest(endpoint, { method: 'GET' });
  const installedCommands = await response.json();
  const namesToRemove = new Set(commandNames);
  const removedCommands = [];

  for (const command of installedCommands) {
    if (!namesToRemove.has(command.name)) continue;
    await DiscordRequest(`${endpoint}/${command.id}`, { method: 'DELETE' });
    removedCommands.push(command.name);
  }

  return removedCommands;
}

// Simple method that returns a random emoji from list
export function getRandomEmoji() {
  const emojiList = ['😭','😄','😌','🤓','😎','😤','🤖','😶‍🌫️','🌏','📸','💿','👋','🌊','✨'];
  return emojiList[Math.floor(Math.random() * emojiList.length)];
}

export function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
