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
  // Accept the old subcommand payload briefly while Discord propagates the new command schema.
  const legacySubcommand = commandOptions.find((option) => option.type === 1);
  const options = legacySubcommand?.options ?? commandOptions;
  const name = legacySubcommand?.name ?? getOptionValue(options, 'mode');

  if (!['ask', 'exam', 'guide', 'upload'].includes(name)) {
    return { error: "I don't recognize that study activity." };
  }

  const inputValue = getOptionValue(options, 'input');
  const questionValue = getOptionValue(options, 'question') ?? (name === 'ask' ? inputValue : undefined);
  const topicValue = getOptionValue(options, 'topic') ?? (name === 'exam' || name === 'guide' ? inputValue : undefined);
  const question = typeof questionValue === 'string' ? questionValue.trim() : '';
  const topic = typeof topicValue === 'string' ? topicValue.trim() : '';
  const attachmentId = getOptionValue(options, 'file');
  let attachment;

  if (typeof attachmentId === 'string') {
    attachment = resolvedAttachments?.[attachmentId];
    const validation = validateAttachment(attachment);
    if (validation.error) return validation;
    attachment = { ...validation, size: attachment.size };
  } else if (attachmentId !== undefined) {
    return { error: "I couldn't identify the attachment. Please attach it again." };
  }

  if (name === 'ask' && !question) return { error: 'Enter a study question.' };
  if (name === 'upload' && !attachment) return { error: 'Attach a study file.' };
  if ((name === 'guide' || name === 'exam') && !topic && !attachment) {
    return { error: 'Enter a topic or attach a study file.' };
  }

  return { name, question, topic, attachment };
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
  if (request.name === 'exam') return `Exam topic: ${request.topic || 'use the attached file'}`;
  if (request.name === 'guide') return `Study guide topic: ${request.topic || 'use the attached file'}`;
  return 'Analyze the attached file and prepare study notes.';
}

export async function buildStudyOpenRouterRequest(request) {
  const systemPrompt = getStudySystemPrompt(request.name);
  const taskPrompt = getTaskPrompt(request);

  if (!request.attachment) {
    return {
      systemPrompt,
      userContent: taskPrompt,
      maxTokens: request.name === 'exam' || request.name === 'guide' ? 1400 : 900,
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
      maxTokens: request.name === 'exam' || request.name === 'guide' ? 1400 : 900,
      plugins: [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }],
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
    maxTokens: request.name === 'exam' || request.name === 'guide' ? 1400 : 900,
  };
}
