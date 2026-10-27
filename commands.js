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

const ALL_COMMANDS = [ASK_COMMAND, RESEARCH_COMMAND, STUDY_COMMAND, OCI_COMMAND];

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
