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
import { ASK_SYSTEM_PROMPT } from './agents/ask.js';
import { RESEARCH_SYSTEM_PROMPT } from './agents/research.js';
import { getOciSystemPrompt, getOciTopic } from './agents/oci.js';
import { getOpenRouterAnswer, isOpenRouterConfigured } from './openrouter.js';
import {
  buildStudyOpenRouterRequest,
  getStudyCommandRequest,
  StudyFileError,
} from './study.js';

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;
const DISCORD_API_URL = 'https://discord.com/api/v10';
// To keep track of our active games
const activeGames = {};

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

function limitDiscordMessage(content) {
  const characters = Array.from(content);
  return characters.length > 1900
    ? `${characters.slice(0, 1897).join('')}…`
    : content;
}

async function answerInteraction(applicationId, interactionToken, requestFactory, operation, failureMessage) {
  let content;
  try {
    const request = await requestFactory();
    const answer = await getOpenRouterAnswer(request);
    content = limitDiscordMessage(answer);
  } catch (error) {
    if (error instanceof StudyFileError) {
      content = error.userMessage;
    } else {
      console.error(`${operation} failed:`, error.message);
      content = failureMessage;
    }
  }

  try {
    await updateInteractionResponse(applicationId, interactionToken, content);
  } catch (error) {
    console.error('Could not update the Discord interaction:', error.message);
  }
}

function deferOpenRouterCommand(res, req, requestFactory, operation, failureMessage) {
  res.send({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL },
  });

  setImmediate(() => {
    void answerInteraction(
      req.body.application_id,
      req.body.token,
      requestFactory,
      operation,
      failureMessage,
    );
  });
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
            content: 'Enter a question for the assistant.',
          },
        });
      }

      if (!isOpenRouterConfigured()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Set OPENROUTER_API_KEY and OPENROUTER_MODEL in the bot environment.',
          },
        });
      }

      return deferOpenRouterCommand(
        res,
        req,
        async () => ({
          systemPrompt: ASK_SYSTEM_PROMPT,
          userContent: prompt.trim(),
          maxTokens: 800,
        }),
        '/ask',
        "I couldn't get an answer right now. Please try again shortly.",
      );
    }

    if (name === 'research') {
      const query = data.options?.find((option) => option.name === 'query')?.value;

      if (typeof query !== 'string' || !query.trim()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Enter a question or topic to research.',
          },
        });
      }

      if (!isOpenRouterConfigured()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Set OPENROUTER_API_KEY and OPENROUTER_MODEL in the bot environment.',
          },
        });
      }

      return deferOpenRouterCommand(
        res,
        req,
        async () => ({
          systemPrompt: RESEARCH_SYSTEM_PROMPT,
          userContent: query.trim(),
          maxTokens: 1200,
          tools: [{ type: 'openrouter:web_search' }],
        }),
        '/research',
        "I couldn't complete the research right now. Please try again shortly.",
      );
    }

    if (name === 'oci') {
      const topicValue = data.options?.find((option) => option.name === 'topic')?.value;
      const question = data.options?.find((option) => option.name === 'question')?.value;
      const topic = getOciTopic(topicValue);

      if (!topic || typeof question !== 'string' || !question.trim()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Choose an OCI topic and enter a question.',
          },
        });
      }

      if (!isOpenRouterConfigured()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Set OPENROUTER_API_KEY and OPENROUTER_MODEL in the bot environment.',
          },
        });
      }

      return deferOpenRouterCommand(
        res,
        req,
        async () => ({
          systemPrompt: getOciSystemPrompt(topic),
          userContent: question.trim(),
          maxTokens: 1400,
          tools: [{ type: 'openrouter:web_search' }],
        }),
        `/oci ${topic.value}`,
        "I couldn't answer this OCI question right now. Please try again shortly.",
      );
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

    if (name === 'study') {
      const studyRequest = getStudyCommandRequest(data.options, data.resolved?.attachments);
      if (studyRequest.error) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: studyRequest.error,
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }

      if (!isOpenRouterConfigured()) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: 'Set OPENROUTER_API_KEY and OPENROUTER_MODEL in the bot environment.',
          },
        });
      }

      return deferOpenRouterCommand(
        res,
        req,
        () => buildStudyOpenRouterRequest(studyRequest),
        `/study ${studyRequest.name}`,
        "I couldn't complete the study request right now. Please try again shortly.",
      );
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
