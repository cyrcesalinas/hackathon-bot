import 'dotenv/config';
import express from 'express';
import {
  ButtonStyleTypes,
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { getRandomEmoji, DiscordRequest } from './utils.js';
import { getShuffledOptions, getResult } from './game.js';

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DISCORD_API_URL = 'https://discord.com/api/v10';
// To keep track of our active games
const activeGames = {};

async function getOpenRouterAnswer(prompt) {
  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: 'Responde de forma clara y útil. Contesta en el idioma de la pregunta.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 800,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter returned HTTP ${response.status}`);
  }

  const result = await response.json();
  const answer = result.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) {
    throw new Error('OpenRouter returned an empty answer');
  }

  return answer.trim();
}

async function updateInteractionResponse(applicationId, interactionToken, content) {
  const response = await fetch(
    `${DISCORD_API_URL}/webhooks/${applicationId}/${encodeURIComponent(interactionToken)}/messages/@original`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Discord returned HTTP ${response.status} while updating the response`);
  }
}

async function answerInteraction(applicationId, interactionToken, prompt) {
  let content;
  try {
    const answer = await getOpenRouterAnswer(prompt);
    content = answer.length > 1950 ? `${answer.slice(0, 1947)}…` : answer;
  } catch (error) {
    console.error('OpenRouter request failed:', error.message);
    content = 'No pude obtener una respuesta ahora. Inténtalo de nuevo en un momento.';
  }

  try {
    await updateInteractionResponse(applicationId, interactionToken, content);
  } catch (error) {
    console.error('Could not update the Discord interaction:', error.message);
  }
}

/**
 * Interactions endpoint URL where Discord will send HTTP requests
 * Parse request body and verifies incoming requests using discord-interactions package
 */
app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), async function (req, res) {
  // Interaction id, type and data
  const { id, type, data } = req.body;

  /**
   * Handle verification requests
   */
  if (type === InteractionType.PING) {
    return res.send({ type: InteractionResponseType.PONG });
  }

  /**
   * Handle slash command requests
   * See https://discord.com/developers/docs/interactions/application-commands#slash-commands
   */
  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name } = data;

    if (name === 'ask') {
      const prompt = data.options?.find((option) => option.name === 'prompt')?.value;

      if (typeof prompt !== 'string' || !prompt.trim()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Escribe una pregunta para el asistente.',
          },
        });
      }

      if (!process.env.OPENROUTER_API_KEY || !process.env.OPENROUTER_MODEL) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Configura OPENROUTER_API_KEY y OPENROUTER_MODEL en el entorno del bot.',
          },
        });
      }

      // Acknowledge now so the LLM request can finish after Discord's 3-second deadline.
      res.send({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: InteractionResponseFlags.EPHEMERAL },
      });

      setImmediate(() => {
        void answerInteraction(req.body.application_id, req.body.token, prompt.trim());
      });
      return;
    }

    // "test" command
    if (name === 'test') {
      // Send a message into the channel where command was triggered from
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.IS_COMPONENTS_V2,
          components: [
            {
              type: MessageComponentTypes.TEXT_DISPLAY,
              // Fetches a random emoji to send from a helper function
              content: `hello world ${getRandomEmoji()}`
            }
          ]
        },
      });
    }

    console.error(`unknown command: ${name}`);
    return res.status(400).json({ error: 'unknown command' });
  }

  console.error('unknown interaction type', type);
  return res.status(400).json({ error: 'unknown interaction type' });
});

app.listen(PORT, () => {
  console.log('Listening on port', PORT);
});
