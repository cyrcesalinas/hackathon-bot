import path from 'node:path';
import { getStudySystemPrompt } from './agents/study.js';

const MAX_STUDY_FILE_BYTES = 8 * 1024 * 1024;
const MAX_STUDY_TEXT_CHARS = 30_000;
const SUPPORTED_TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json']);
const DISCORD_ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

export class StudyFileError extends Error {
  constructor(userMessage) {
    super(userMessage);
    this.userMessage = userMessage;
  }
}

function getOptionValue(options, name) {
  return options?.find((option) => option.name === name)?.value;
}

function getSafeFilename(filename) {
  if (typeof filename !== 'string' || !filename.trim()) return 'study-file';
  const normalized = filename.replace(/\\/g, '/');
  return path.posix.basename(normalized).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100) || 'study-file';
}

function validateAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') {
    return { error: "I couldn't find the attachment. Please attach it again." };
  }

  if (Number.isFinite(attachment.size) && attachment.size > MAX_STUDY_FILE_BYTES) {
    return { error: 'The file exceeds the 8 MB limit.' };
  }

  const filename = getSafeFilename(attachment.filename);
  const extension = path.extname(filename).toLowerCase();
  if (extension !== '.pdf' && !SUPPORTED_TEXT_EXTENSIONS.has(extension)) {
    return { error: 'Unsupported file type. Use PDF, TXT, MD, CSV, or JSON.' };
  }

  if (typeof attachment.url !== 'string' || !attachment.url) {
    return { error: "I couldn't read the attachment URL. Please attach it again." };
  }

  return { filename, extension, url: attachment.url };
}

export function getStudyCommandRequest(commandOptions = [], resolvedAttachments = {}) {
  // Keep accepting existing subcommand and mode payloads while Discord updates the command schema.
  const legacySubcommand = commandOptions.find((option) => option.type === 1);
  const options = legacySubcommand?.options ?? commandOptions;
  const selectedActivity = legacySubcommand?.name
    ?? getOptionValue(options, 'action')
    ?? getOptionValue(options, 'mode');
  const name = selectedActivity === 'question' ? 'ask' : selectedActivity;

  if (!['ask', 'exam', 'guide', 'upload'].includes(name)) {
    return { error: "I don't recognize that study activity." };
  }

  const inputValue = getOptionValue(options, 'input');
  const rawQuestionCount = getOptionValue(options, 'questions');
  const questionCount = rawQuestionCount === undefined ? 5 : rawQuestionCount;
  if (name === 'exam' && (!Number.isInteger(questionCount) || questionCount < 3 || questionCount > 10)) {
    return { error: 'Choose between 3 and 10 exam questions.' };
  }
  const questionValue = getOptionValue(options, 'question') ?? (name === 'ask' ? inputValue : undefined);
  const topicValue = getOptionValue(options, 'topic') ?? (name === 'exam' || name === 'guide' ? inputValue : undefined);
  const question = typeof questionValue === 'string' ? questionValue.trim() : '';
  const topic = typeof topicValue === 'string' ? topicValue.trim() : '';
  const attachmentId = getOptionValue(options, 'file');
  let attachment;

  if (name === 'ask' && attachmentId !== undefined) {
    return { error: 'Question accepts input only. Remove file and write your question in input.' };
  }
  if (name === 'upload' && options.some((option) => (
    ['input', 'question', 'topic'].includes(option.name) &&
    typeof option.value === 'string' && option.value.trim()
  ))) {
    return { error: 'Upload accepts file only. Remove input and attach your study file.' };
  }
  if (name !== 'exam' && rawQuestionCount !== undefined) {
    return { error: 'The questions option is for Exam only. Remove it for this activity.' };
  }

  if (typeof attachmentId === 'string') {
    attachment = resolvedAttachments?.[attachmentId];
    const validation = validateAttachment(attachment);
    if (validation.error) return validation;
    attachment = { ...validation, size: attachment.size };
  } else if (attachmentId !== undefined) {
    return { error: "I couldn't identify the attachment. Please attach it again." };
  }

  if (name === 'ask' && !question) return { error: 'Write your study question in input.' };
  if (name === 'upload' && !attachment) return { error: 'Attach your study material using file.' };
  if ((name === 'guide' || name === 'exam') && !topic && !attachment) {
    return { error: 'Write a topic in input or attach study material using file.' };
  }

  return {
    name,
    question,
    topic,
    attachment,
    ...(name === 'exam' ? { questionCount } : {}),
  };
}

async function readAttachmentWithinLimit(attachment) {
  let url;
  try {
    url = new URL(attachment.url);
  } catch {
    throw new StudyFileError("I couldn't read the attachment URL. Please attach it again.");
  }

  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username ||
    url.password ||
    !DISCORD_ATTACHMENT_HOSTS.has(url.hostname)
  ) {
    throw new StudyFileError('The file must be attached directly in Discord.');
  }

  let response;
  try {
    response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new StudyFileError("I couldn't download the file from Discord. Please try again.");
  }

  if (!response.ok) {
    throw new StudyFileError("Discord couldn't provide the file. Please attach it again.");
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_STUDY_FILE_BYTES) {
    throw new StudyFileError('The file exceeds the 8 MB limit.');
  }

  if (!response.body) throw new StudyFileError('Discord returned an empty file.');

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_STUDY_FILE_BYTES) {
        await reader.cancel();
        throw new StudyFileError('The file exceeds the 8 MB limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof StudyFileError) throw error;
    throw new StudyFileError("I couldn't read the attachment. Please attach it again.");
  }

  if (totalBytes === 0) throw new StudyFileError('The file is empty.');
  return Buffer.concat(chunks, totalBytes);
}

function getTaskPrompt(request) {
  if (request.name === 'ask') return `Student question: ${request.question}`;
  if (request.name === 'exam') {
    const questionCount = Number.isInteger(request.questionCount) ? request.questionCount : 5;
    return `Make a ${questionCount}-question multiple-choice exam. Topic: ${request.topic || 'the attached file'}.`;
  }
  if (request.name === 'guide') return `Study guide topic: ${request.topic || 'use the attached file'}`;
  return 'Analyze the attached file and prepare study notes.';
}

function getUploadMaxTokens() {
  const configured = Number(process.env.OPENROUTER_STUDY_MAX_TOKENS);
  if (!Number.isSafeInteger(configured) || configured < 1) return 1800;
  return Math.min(configured, 4000);
}

function getStudyExamResponseFormat() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'study_exam',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string' },
                choices: {
                  type: 'array',
                  items: { type: 'string' },
                },
                correctIndex: { type: 'integer', enum: [0, 1, 2, 3] },
                explanation: { type: 'string' },
              },
              required: ['question', 'choices', 'correctIndex', 'explanation'],
              additionalProperties: false,
            },
          },
        },
        required: ['title', 'questions'],
        additionalProperties: false,
      },
    },
  };
}

function getStudyResponseOptions(request) {
  const { name } = request;
  const questionCount = Number.isInteger(request.questionCount) ? request.questionCount : 5;
  return {
    maxTokens: name === 'guide'
      ? 4000
      : name === 'exam'
        ? Math.min(4000, 500 + questionCount * 350)
        : name === 'upload'
          ? getUploadMaxTokens()
          : 900,
    ...(name === 'exam' ? {
      responseFormat: getStudyExamResponseFormat(),
      reasoning: { effort: 'low' },
    } : {}),
    ...(name === 'guide' ? { tools: [{ type: 'openrouter:web_search' }] } : {}),
  };
}

export function getStudyGuideFilename(request) {
  const sourceName = request.topic || request.attachment?.filename?.replace(/\.[^.]+$/, '') || 'notes';
  const slug = sourceName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return `study-guide-${slug || 'notes'}.md`;
}

export async function buildStudyOpenRouterRequest(request) {
  const systemPrompt = getStudySystemPrompt(request.name);
  const taskPrompt = getTaskPrompt(request);

  if (!request.attachment) {
    return {
      systemPrompt,
      userContent: taskPrompt,
      ...getStudyResponseOptions(request),
    };
  }

  const bytes = await readAttachmentWithinLimit(request.attachment);
  const filename = request.attachment.filename;

  if (request.attachment.extension === '.pdf') {
    if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new StudyFileError('The file has a PDF extension, but its contents do not appear to be a valid PDF.');
    }

    return {
      systemPrompt,
      userContent: [
        { type: 'text', text: `${taskPrompt}\nMaterial adjunto: ${filename}` },
        {
          type: 'file',
          file: {
            filename,
            file_data: `data:application/pdf;base64,${bytes.toString('base64')}`,
          },
        },
      ],
      plugins: [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }],
      ...getStudyResponseOptions(request),
    };
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new StudyFileError('The file must contain valid UTF-8 text.');
  }

  if (text.includes('\u0000')) {
    throw new StudyFileError('The file does not appear to contain valid UTF-8 text.');
  }
  if (!text.trim()) throw new StudyFileError('The file does not contain any text to study.');

  const truncated = Array.from(text).length > MAX_STUDY_TEXT_CHARS;
  if (truncated) text = Array.from(text).slice(0, MAX_STUDY_TEXT_CHARS).join('');

  return {
    systemPrompt,
    userContent: `${taskPrompt}\nAttached file: ${filename}\n\nFile contents:\n${text}${truncated ? '\n\n[The file was shortened to fit the processing limit.]' : ''}`,
    ...getStudyResponseOptions(request),
  };
}
