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
import { handleStudyCommand } from './study.js';

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

    // Study Assistant command skeleton. The handler returns placeholders only.
    if (name === 'study') {
      const content = handleStudyCommand(data.options);
      if (!content) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'Unknown Study Assistant command.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content,
          flags: InteractionResponseFlags.EPHEMERAL,
        },
      });
    }

    // "challenge" command
    if (name === 'challenge' && id) {
      // User ID is in the member field for servers and the user field for DMs.
      const userId = req.body.member?.user?.id ?? req.body.user?.id;
      const objectName = data.options?.[0]?.value;

      if (!userId || !objectName) {
        return res.status(400).json({ error: 'invalid challenge command' });
      }

      activeGames[id] = {
        id: userId,
        objectName,
      };

      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.IS_COMPONENTS_V2,
          components: [
            {
              type: MessageComponentTypes.TEXT_DISPLAY,
              content: `Rock paper scissors challenge from <@${userId}>`,
            },
            {
              type: MessageComponentTypes.ACTION_ROW,
              components: [
                {
                  type: MessageComponentTypes.BUTTON,
                  custom_id: `accept_button_${id}`,
                  label: 'Accept',
                  style: ButtonStyleTypes.PRIMARY,
                },
              ],
            },
          ],
        },
      });
    }

    console.error(`unknown command: ${name}`);
    return res.status(400).json({ error: 'unknown command' });
  }

  /**
   * Handle button and select menu interactions.
   * See https://discord.com/developers/docs/components/using-message-components#using-message-components-with-interactions
   */
  if (type === InteractionType.MESSAGE_COMPONENT) {
    const componentId = data.custom_id;

    if (componentId.startsWith('accept_button_')) {
      const gameId = componentId.replace('accept_button_', '');

      if (!activeGames[gameId]) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'This challenge is no longer active.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      const endpoint = `webhooks/${process.env.APP_ID}/${req.body.token}/messages/${req.body.message.id}`;

      try {
        res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags:
              InteractionResponseFlags.EPHEMERAL |
              InteractionResponseFlags.IS_COMPONENTS_V2,
            components: [
              {
                type: MessageComponentTypes.TEXT_DISPLAY,
                content: 'What is your object of choice?',
              },
              {
                type: MessageComponentTypes.ACTION_ROW,
                components: [
                  {
                    type: MessageComponentTypes.STRING_SELECT,
                    custom_id: `select_choice_${gameId}`,
                    options: getShuffledOptions(),
                  },
                ],
              },
            ],
          },
        });

        await DiscordRequest(endpoint, { method: 'DELETE' });
      } catch (err) {
        console.error('Error accepting challenge:', err);
      }

      return;
    }

    if (componentId.startsWith('select_choice_')) {
      const gameId = componentId.replace('select_choice_', '');
      const game = activeGames[gameId];

      if (!game) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: 'This challenge is no longer active.',
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      const userId = req.body.member?.user?.id ?? req.body.user?.id;
      const objectName = data.values?.[0];

      if (!userId || !objectName) {
        return res.status(400).json({ error: 'invalid challenge selection' });
      }

      const result = getResult(game, { id: userId, objectName });
      delete activeGames[gameId];

      const endpoint = `webhooks/${process.env.APP_ID}/${req.body.token}/messages/${req.body.message.id}`;

      try {
        res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.IS_COMPONENTS_V2,
            components: [
              {
                type: MessageComponentTypes.TEXT_DISPLAY,
                content: result,
              },
            ],
          },
        });

        await DiscordRequest(endpoint, {
          method: 'PATCH',
          body: {
            components: [
              {
                type: MessageComponentTypes.TEXT_DISPLAY,
                content: `Nice choice ${getRandomEmoji()}`,
              },
            ],
          },
        });
      } catch (err) {
        console.error('Error completing challenge:', err);
      }

      return;
    }

    return res.status(400).json({ error: 'unknown component' });
  }

  console.error('unknown interaction type', type);
  return res.status(400).json({ error: 'unknown interaction type' });
});

app.listen(PORT, () => {
  console.log('Listening on port', PORT);
});
