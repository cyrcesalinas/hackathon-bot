import { buildUserAgentRequest } from './agents/user-agent.js';
import { buildAgentFollowUpUserContent } from './prompts.js';

export const AGENT_CONVERSATION_TTL_MS = 60 * 60_000;
const AGENT_CONVERSATION_LIMIT = 100;
const MAX_PREVIOUS_ANSWER_CHARS = 12_000;
const conversations = new Map();

function truncate(value, maxLength) {
  const characters = Array.from(String(value ?? ''));
  return characters.length <= maxLength
    ? characters.join('')
    : `${characters.slice(0, Math.max(0, maxLength - 1)).join('')}…`;
}

export function cleanExpiredAgentConversations(now = Date.now()) {
  for (const [messageId, conversation] of conversations) {
    if (conversation.expiresAt <= now) conversations.delete(messageId);
  }
  while (conversations.size >= AGENT_CONVERSATION_LIMIT) {
    conversations.delete(conversations.keys().next().value);
  }
}

export function storeAgentConversation(messageId, data, now = Date.now()) {
  if (typeof messageId !== 'string' || !messageId) return null;
  cleanExpiredAgentConversations(now);
  const conversation = {
    ownerUserId: data.ownerUserId,
    channelId: data.channelId,
    agent: data.agent,
    originalTask: data.originalTask,
    attachmentId: data.attachmentId,
    resolvedAttachments: data.resolvedAttachments ?? {},
    previousTask: data.previousTask ?? data.originalTask,
    previousAnswer: truncate(data.previousAnswer, MAX_PREVIOUS_ANSWER_CHARS),
    expiresAt: now + AGENT_CONVERSATION_TTL_MS,
  };
  conversations.set(messageId, conversation);
  return conversation;
}

export function getAgentConversation(messageId, now = Date.now()) {
  const conversation = conversations.get(messageId);
  if (!conversation || conversation.expiresAt <= now) {
    conversations.delete(messageId);
    return null;
  }
  conversation.expiresAt = now + AGENT_CONVERSATION_TTL_MS;
  return conversation;
}

export async function buildAgentFollowUpRequest(conversation, followUpTask) {
  const request = await buildUserAgentRequest(
    conversation.agent,
    followUpTask,
    conversation.attachmentId,
    conversation.resolvedAttachments,
  );
  request.userContent = buildAgentFollowUpUserContent(request.userContent, {
    originalTask: conversation.originalTask,
    previousTask: conversation.previousTask,
    previousAnswer: conversation.previousAnswer,
    followUpTask,
  });
  return request;
}
