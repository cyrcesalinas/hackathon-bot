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
  description: 'Pregunta a Lian y recibe una explicación clara paso a paso',
  options: [
    {
      type: 3,
      name: 'prompt',
      description: 'Escribe tu pregunta o el concepto que quieres aprender',
      required: true,
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const RESEARCH_COMMAND = {
  name: 'research',
  description: 'Investiga un tema en la web y comparte las fuentes consultadas',
  options: [
    {
      type: 3,
      name: 'query',
      description: 'Pregunta o tema que quieres investigar',
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
  description: 'Aprende con preguntas, guías, apuntes y exámenes de práctica',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      type: 3,
      name: 'mode',
      description: 'Elige la actividad de estudio',
      required: true,
      choices: [
        { name: 'Pregunta de estudio', value: 'ask' },
        { name: 'Subir material de estudio', value: 'upload' },
        { name: 'Examen de práctica', value: 'exam' },
        { name: 'Guía de estudio', value: 'guide' },
      ],
    },
    {
      type: 3,
      name: 'input',
      description: 'Pregunta o tema, según la actividad',
      required: false,
    },
    {
      type: 11,
      name: 'file',
      description: 'Archivo opcional; obligatorio para subir material',
      required: false,
    },
  ],
};

const OCI_COMMAND = {
  name: 'oci',
  description: 'Aprende Oracle AI Database, GoldenGate, AI Lakehouse y Deep Trust AI',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      type: 3,
      name: 'topic',
      description: 'Elige el servicio o la arquitectura de Oracle',
      required: true,
      choices: OCI_TOPICS.map(({ name, value }) => ({ name, value })),
    },
    {
      type: 3,
      name: 'question',
      description: 'Pregunta técnica o conceptual sobre el tema elegido',
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
