import 'dotenv/config';
import { InstallGlobalCommands, RemoveGlobalCommands } from './utils.js';
import { OCI_TOPICS } from './agents/oci.js';
import {
  AGENT_LANGUAGES,
  AGENT_PRESET_DEFINITIONS,
  AGENT_RESPONSE_FORMATS,
} from './agents/agent-config.js';

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

const DB_COMMAND = {
  name: 'db',
  description: 'Ask questions about approved database data',
  type: 1,
  integration_types: [0],
  contexts: [0],
  options: [
    {
      type: 3,
      name: 'action',
      description: 'Choose a database action',
      required: true,
      choices: [
        { name: 'Discover schema tables and views for the approved catalog', value: 'scan' },
        { name: 'Check the bot connection to ADB', value: 'status' },
        { name: 'Query schema data; do not request or share sensitive information', value: 'lookup' },
      ],
    },
    {
      type: 3,
      name: 'question',
      description: 'Question for Query schema data only',
      required: false,
      max_length: 500,
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

const STUDY_COMMAND = {
  name: 'study',
  description: 'Learn with questions, study guides, notes, and practice exams',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      type: 3,
      name: 'action',
      description: 'Choose what to do with your study material',
      required: true,
      choices: [
        { name: 'Guide: Create a study guide', value: 'guide' },
        { name: 'Question: Get a step-by-step explanation', value: 'question' },
        { name: 'Exam: Practice with an interactive quiz', value: 'exam' },
        { name: 'Upload: Analyze a study file and create notes', value: 'upload' },
      ],
    },
    {
      type: 3,
      name: 'input',
      description: 'Topic for Guide/Exam, or your question for Question. Leave empty for Upload.',
      required: false,
      max_length: 1500,
    },
    {
      type: 11,
      name: 'file',
      description: 'Study file for Guide/Exam/Upload. Required for Upload; max 8 MB.',
      required: false,
      file_types: ['.pdf', '.txt', '.md', '.markdown', '.csv', '.json'],
    },
    {
      type: 4,
      name: 'questions',
      description: 'Exam only: number of quiz questions (3–10; default 5)',
      required: false,
      min_value: 3,
      max_value: 10,
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

const AGENT_PRESET_CHOICES = Object.values(AGENT_PRESET_DEFINITIONS)
  .map(({ name, id }) => ({ name, value: id }));
const AGENT_RESPONSE_FORMAT_CHOICES = Object.entries(AGENT_RESPONSE_FORMATS)
  .map(([value, name]) => ({ name, value }));
const AGENT_LANGUAGE_CHOICES = Object.entries(AGENT_LANGUAGES)
  .map(([value, name]) => ({ name, value }));

const AGENT_COMMAND = {
  name: 'agent',
  description: 'Create, share, manage, and run learning agents',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      type: 3,
      name: 'action',
      description: 'Choose what to do with an agent',
      required: true,
      choices: [
        { name: 'Create agent', value: 'create' },
        { name: 'Delete agent', value: 'delete' },
        { name: 'Edit agent', value: 'edit' },
        { name: 'List saved agents', value: 'list' },
        { name: 'Browse shared agents', value: 'shared' },
        { name: 'Share an agent with this server', value: 'share' },
        { name: 'Make an agent private', value: 'unshare' },
        { name: 'Run an agent', value: 'run' },
        { name: 'Test an agent', value: 'test' },
      ],
    },
    { type: 3, name: 'name', description: 'Agent name (your agent, or a shared agent when running)', required: false, max_length: 32 },
    { type: 3, name: 'goal', description: 'What should this agent help you learn or build? (create or edit)', required: false, max_length: 1000 },
    { type: 3, name: 'style', description: 'How should it explain or respond? (create or edit)', required: false, max_length: 300 },
    {
      type: 3,
      name: 'preset',
      description: 'Behavior preset (create or edit)',
      required: false,
      choices: AGENT_PRESET_CHOICES,
    },
    { type: 5, name: 'web_search', description: 'Enable or disable web research (create or edit)', required: false },
    { type: 5, name: 'file_analysis', description: 'Enable or disable study-file analysis (create or edit)', required: false },
    {
      type: 3,
      name: 'response_format',
      description: 'Output format (create or edit)',
      required: false,
      choices: AGENT_RESPONSE_FORMAT_CHOICES,
    },
    {
      type: 3,
      name: 'language',
      description: 'Response language (create or edit)',
      required: false,
      choices: AGENT_LANGUAGE_CHOICES,
    },
    { type: 3, name: 'task', description: 'What should the selected agent help you with? (run or test)', required: false, max_length: 1500 },
    { type: 11, name: 'file', description: 'Optional file (run or test; requires file analysis)', required: false },
    { type: 3, name: 'new_name', description: 'New agent name (edit only)', required: false, max_length: 32 },
  ],
};

const ALL_COMMANDS = [
  ASK_COMMAND,
  DB_COMMAND,
  RESEARCH_COMMAND,
  STUDY_COMMAND,
  OCI_COMMAND,
  AGENT_COMMAND,
];

try {
  const installedCommands = await InstallGlobalCommands(
    process.env.APP_ID,
    ALL_COMMANDS,
  );
  const removedCommands = await RemoveGlobalCommands(process.env.APP_ID, ['agents', 'challenge', 'test', 'dev']);
  const commandNames = installedCommands.map(({ name }) => `/${name}`).join(', ');
  console.log(`Installed ${installedCommands.length} global commands: ${commandNames}`);
  if (removedCommands.length) {
    console.log(`Removed legacy global commands: ${removedCommands.map((name) => `/${name}`).join(', ')}`);
  }
} catch (err) {
  console.error('Failed to install global commands:', err);
  process.exitCode = 1;
}
