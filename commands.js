import 'dotenv/config';
import { getRPSChoices } from './game.js';
import { capitalize, InstallGlobalCommands } from './utils.js';
import { OCI_TOPICS } from './agents/oci.js';

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
  description: 'Ask Lian for a clear, step-by-step explanation',
  options: [
    {
      type: 3,
      name: 'prompt',
      description: 'Your question or the concept you want to learn',
      required: true,
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const DEV_COMMAND = {
  name: 'dev',
  description: 'Get engineering help for your project',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      type: 1,
      name: 'ask',
      description: 'Ask how to implement something',
      options: [
        {
          type: 3,
          name: 'question',
          description: 'What you want to build or understand',
          required: true,
          max_length: 1500,
        },
        {
          type: 11,
          name: 'context',
          description: 'Optional Markdown, text, or source-code context (up to 1 MB)',
          required: false,
        },
      ],
    },
  ],
};

const DB_COMMAND = {
  name: 'db',
  description: 'Ask questions about approved database data',
  type: 1,
  integration_types: [0],
  contexts: [0],
  options: [
    {
      type: 1,
      name: 'status',
      description: 'Check the bot connection to ADB',
    },
    {
      type: 1,
      name: 'scan',
      description: 'Admin: discover schema tables and views for the approved catalog',
    },
    {
      type: 1,
      name: 'lookup',
      description: 'Query schema data; do not request or share sensitive information',
      options: [
        {
          type: 3,
          name: 'question',
          description: 'What you would like to look up',
          required: true,
          max_length: 500,
        },
      ],
    },
  ],
};

const RESEARCH_COMMAND = {
  name: 'research',
  description: 'Research a topic on the web and get cited sources',
  options: [
    {
      type: 3,
      name: 'query',
      description: 'The question or topic you want researched',
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

// Command containing options

const STUDY_COMMAND = {
  name: 'study',
  description: 'Learn with questions, study guides, notes, and practice exams',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      type: 3,
      name: 'mode',
      description: 'Choose a study activity',
      required: true,
      choices: [
        { name: 'Study question', value: 'ask' },
        { name: 'Upload study material', value: 'upload' },
        { name: 'Practice exam', value: 'exam' },
        { name: 'Study guide', value: 'guide' },
      ],
    },
    {
      type: 3,
      name: 'input',
      description: 'Question or topic, depending on the activity',
      required: false,
    },
    {
      type: 11,
      name: 'file',
      description: 'Optional study file; required for upload',
      required: false,
    },
  ],
};

const OCI_COMMAND = {
  name: 'oci',
  description: 'Learn Oracle AI Database, GoldenGate, AI Lakehouse, and Deep Trust AI',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      type: 3,
      name: 'topic',
      description: 'Choose an Oracle service or architecture',
      required: true,
      choices: OCI_TOPICS.map(({ name, value }) => ({ name, value })),
    },
    {
      type: 3,
      name: 'question',
      description: 'A technical or conceptual question about the selected topic',
      required: true,
    },
  ],
};

const AGENT_COMMAND = {
  name: 'agent',
  description: 'Create and use your own learning agents',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      type: 1,
      name: 'create',
      description: 'Build and preview a private learning agent',
      options: [
        {
          type: 3,
          name: 'name',
          description: 'A short name for your agent',
          required: true,
          max_length: 32,
        },
        {
          type: 3,
          name: 'goal',
          description: 'What should this agent help you do?',
          required: true,
          max_length: 1000,
        },
        {
          type: 3,
          name: 'style',
          description: 'How should it explain or respond?',
          required: true,
          max_length: 300,
        },
        {
          type: 3,
          name: 'capability',
          description: 'Choose what this agent can do',
          required: true,
          choices: [
            { name: 'Chat', value: 'chat' },
            { name: 'Study help with files', value: 'study' },
            { name: 'Web research', value: 'research' },
          ],
        },
      ],
    },
    {
      type: 1,
      name: 'list',
      description: 'Show your saved agents',
    },
    {
      type: 1,
      name: 'run',
      description: 'Give one of your agents a task',
      options: [
        {
          type: 3,
          name: 'name',
          description: 'Your agent name',
          required: true,
          max_length: 32,
        },
        {
          type: 3,
          name: 'task',
          description: 'What you want the agent to help with',
          required: true,
          max_length: 1500,
        },
        {
          type: 11,
          name: 'file',
          description: 'Optional study file (study agents only)',
          required: false,
        },
      ],
    },
    {
      type: 1,
      name: 'edit',
      description: 'Change one of your agents',
      options: [
        {
          type: 3,
          name: 'name',
          description: 'Current agent name',
          required: true,
          max_length: 32,
        },
        {
          type: 3,
          name: 'new_name',
          description: 'New name',
          required: false,
          max_length: 32,
        },
        {
          type: 3,
          name: 'goal',
          description: 'New goal',
          required: false,
          max_length: 1000,
        },
        {
          type: 3,
          name: 'style',
          description: 'New response style',
          required: false,
          max_length: 300,
        },
        {
          type: 3,
          name: 'capability',
          description: 'New capability',
          required: false,
          choices: [
            { name: 'Chat', value: 'chat' },
            { name: 'Study help with files', value: 'study' },
            { name: 'Web research', value: 'research' },
          ],
        },
      ],
    },
    {
      type: 1,
      name: 'delete',
      description: 'Delete one of your agents',
      options: [
        {
          type: 3,
          name: 'name',
          description: 'Agent name',
          required: true,
          max_length: 32,
        },
      ],
    },
  ],
};

const ALL_COMMANDS = [
  TEST_COMMAND,
  ASK_COMMAND,
  DEV_COMMAND,
  DB_COMMAND,
  RESEARCH_COMMAND,
  CHALLENGE_COMMAND,
  STUDY_COMMAND,
  OCI_COMMAND,
  AGENT_COMMAND,
];

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
