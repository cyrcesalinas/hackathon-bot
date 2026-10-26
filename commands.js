import 'dotenv/config';
import { getRPSChoices } from './game.js';
import { capitalize, InstallGlobalCommands } from './utils.js';

// Get the game choices from game.js
function createCommandChoices() {
  const choices = getRPSChoices();
  const commandChoices = [];

  for (let choice of choices) {
    commandChoices.push({
      name: capitalize(choice),
      value: choice.toLowerCase(),
    });
  }

  return commandChoices;
}

// Simple test command
const TEST_COMMAND = {
  name: 'test',
  description: 'Basic command',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

// Ask an LLM a question using OpenRouter
const ASK_COMMAND = {
  name: 'ask',
  description: 'Ask the AI assistant a question',
  options: [
    {
      type: 3,
      name: 'prompt',
      description: 'Your question for the AI assistant',
      required: true,
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const RESEARCH_COMMAND = {
  name: 'research',
  description: 'Research a question with current web sources',
  options: [
    {
      type: 3,
      name: 'query',
      description: 'What you want researched',
      required: true,
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

// Command containing options
const CHALLENGE_COMMAND = {
  name: 'challenge',
  description: 'Challenge to a match of rock paper scissors',
  options: [
    {
      type: 3,
      name: 'object',
      description: 'Pick your object',
      required: true,
      choices: createCommandChoices(),
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 2],
};

const STUDY_COMMAND = {
  name: 'study',
  description: 'Use a Study Assistant tool',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      type: 1,
      name: 'ask',
      description: 'Ask a specific study question',
      options: [
        {
          type: 3,
          name: 'question',
          description: 'The question you want help with',
          required: true,
        },
      ],
    },
    {
      type: 1,
      name: 'upload',
      description: 'Create study notes from a file',
      options: [
        {
          type: 11,
          name: 'file',
          description: 'A study file',
          required: true,
        },
      ],
    },
    {
      type: 1,
      name: 'exam',
      description: 'Prepare a practice exam from a topic or file',
      options: [
        {
          type: 3,
          name: 'topic',
          description: 'Topic for the practice exam',
          required: false,
        },
        {
          type: 11,
          name: 'file',
          description: 'Study file to use for the practice exam',
          required: false,
        },
      ],
    },
    {
      type: 1,
      name: 'guide',
      description: 'Prepare a study guide from a topic or file',
      options: [
        {
          type: 3,
          name: 'topic',
          description: 'Topic for the study guide',
          required: false,
        },
        {
          type: 11,
          name: 'file',
          description: 'Study file to use for the guide',
          required: false,
        },
      ],
    },
  ],
};

const ALL_COMMANDS = [TEST_COMMAND, ASK_COMMAND, RESEARCH_COMMAND, CHALLENGE_COMMAND, STUDY_COMMAND];

try {
  const installedCommands = await InstallGlobalCommands(
    process.env.APP_ID,
    ALL_COMMANDS,
  );
  const commandNames = installedCommands.map(({ name }) => `/${name}`).join(', ');
  console.log(`Installed ${installedCommands.length} global commands: ${commandNames}`);
} catch (err) {
  console.error('Failed to install global commands:', err);
  process.exitCode = 1;
}
