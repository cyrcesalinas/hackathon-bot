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
    return { error: 'No pude encontrar el archivo adjunto. Vuelve a adjuntarlo.' };
  }

  if (Number.isFinite(attachment.size) && attachment.size > MAX_STUDY_FILE_BYTES) {
    return { error: 'El archivo supera el límite de 8 MB.' };
  }

  const filename = getSafeFilename(attachment.filename);
  const extension = path.extname(filename).toLowerCase();
  if (extension !== '.pdf' && !SUPPORTED_TEXT_EXTENSIONS.has(extension)) {
    return { error: 'Formato no compatible. Usa PDF, TXT, MD, CSV o JSON.' };
  }

  if (typeof attachment.url !== 'string' || !attachment.url) {
    return { error: 'No pude leer el enlace del archivo adjunto. Vuelve a adjuntarlo.' };
  }

  return { filename, extension, url: attachment.url };
}

export function getStudyCommandRequest(commandOptions = [], resolvedAttachments = {}) {
  // Accept the old subcommand payload briefly while Discord propagates the new command schema.
  const legacySubcommand = commandOptions.find((option) => option.type === 1);
  const options = legacySubcommand?.options ?? commandOptions;
  const name = legacySubcommand?.name ?? getOptionValue(options, 'mode');

  if (!['ask', 'exam', 'guide', 'upload'].includes(name)) {
    return { error: 'No reconozco ese comando de estudio.' };
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
    return { error: 'No pude reconocer el archivo adjunto. Vuelve a adjuntarlo.' };
  }

  if (name === 'ask' && !question) return { error: 'Escribe una pregunta de estudio.' };
  if (name === 'upload' && !attachment) return { error: 'Adjunta un archivo de estudio.' };
  if ((name === 'guide' || name === 'exam') && !topic && !attachment) {
    return { error: 'Escribe un tema o adjunta un archivo de estudio.' };
  }

  return { name, question, topic, attachment };
}

async function readAttachmentWithinLimit(attachment) {
  let url;
  try {
    url = new URL(attachment.url);
  } catch {
    throw new StudyFileError('No pude leer el enlace del archivo adjunto. Vuelve a adjuntarlo.');
  }

  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username ||
    url.password ||
    !DISCORD_ATTACHMENT_HOSTS.has(url.hostname)
  ) {
    throw new StudyFileError('El archivo debe ser un adjunto directo de Discord.');
  }

  let response;
  try {
    response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new StudyFileError('No pude descargar el archivo desde Discord. Inténtalo de nuevo.');
  }

  if (!response.ok) {
    throw new StudyFileError('Discord no pudo entregar el archivo. Vuelve a adjuntarlo.');
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_STUDY_FILE_BYTES) {
    throw new StudyFileError('El archivo supera el límite de 8 MB.');
  }

  if (!response.body) throw new StudyFileError('Discord devolvió un archivo vacío.');

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
        throw new StudyFileError('El archivo supera el límite de 8 MB.');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof StudyFileError) throw error;
    throw new StudyFileError('No pude leer el archivo adjunto. Vuelve a adjuntarlo.');
  }

  if (totalBytes === 0) throw new StudyFileError('El archivo está vacío.');
  return Buffer.concat(chunks, totalBytes);
}

function getTaskPrompt(request) {
  if (request.name === 'ask') return `Pregunta del estudiante: ${request.question}`;
  if (request.name === 'exam') return `Tema del examen: ${request.topic || 'usa el archivo adjunto'}`;
  if (request.name === 'guide') return `Tema de la guía: ${request.topic || 'usa el archivo adjunto'}`;
  return 'Analiza el archivo adjunto y prepara apuntes de estudio.';
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
      throw new StudyFileError('El archivo tiene extensión PDF, pero su contenido no parece ser un PDF válido.');
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
    throw new StudyFileError('El archivo debe contener texto UTF-8 válido.');
  }

  if (text.includes('\u0000')) {
    throw new StudyFileError('El archivo no parece ser texto UTF-8 válido.');
  }
  if (!text.trim()) throw new StudyFileError('El archivo no contiene texto para estudiar.');

  const truncated = Array.from(text).length > MAX_STUDY_TEXT_CHARS;
  if (truncated) text = Array.from(text).slice(0, MAX_STUDY_TEXT_CHARS).join('');

  return {
    systemPrompt,
    userContent: [
      { type: 'text', text: `${taskPrompt}\nMaterial adjunto: ${filename}` },
      {
        type: 'text',
        text: `Contenido del archivo:\n${text}${truncated ? '\n\n[El archivo se recortó para ajustarse al límite de procesamiento.]' : ''}`,
      },
    ],
    maxTokens: request.name === 'exam' || request.name === 'guide' ? 1400 : 900,
  };
}
