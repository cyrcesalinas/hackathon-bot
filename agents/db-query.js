import {
  getOpenRouterAnswer,
  isOpenRouterConfigured,
  withOpenRouterDateTimeTool,
} from '../openrouter.js';
import { refreshAdbCatalog } from '../db/catalog-scan.js';
import { isAdbConfigured } from '../db/connection.js';
import {
  AdbQueryPlanError,
  executeAdbQuery,
  getPublicAdbCatalog,
  hasAdbQueryCatalog,
} from '../db/query.js';
import {
  buildDbPlannerUserContent,
  DB_PLANNER_SYSTEM_PROMPT,
} from '../prompts.js';

export class DbAssistantError extends Error {
  constructor(userMessage, code = 'DB_ASSISTANT_ERROR') {
    super(code);
    this.name = 'DbAssistantError';
    this.userMessage = userMessage;
    this.code = code;
  }
}

export async function answerAdbQuestion(question) {
  if (!isAdbConfigured()) {
    throw new DbAssistantError('The ADB connection is not configured yet. Contact the bot administrator.', 'ADB_NOT_CONFIGURED');
  }
  if (!isOpenRouterConfigured()) {
    throw new DbAssistantError('The database question service is not configured yet. Contact the bot administrator.', 'OPENROUTER_NOT_CONFIGURED');
  }

  const cleanQuestion = typeof question === 'string' ? question.trim().slice(0, 500) : '';
  if (!cleanQuestion) {
    throw new DbAssistantError('Enter a database question to continue.', 'DB_QUESTION_EMPTY');
  }

  try {
    await refreshAdbCatalog();
  } catch (error) {
    console.error('ADB automatic catalog refresh failed:', error?.code ?? error?.name ?? 'unknown error');
    throw new DbAssistantError('The automatic database catalog could not be loaded. Contact the bot administrator.', 'ADB_CATALOG_REFRESH_FAILED');
  }
  if (!hasAdbQueryCatalog()) {
    throw new DbAssistantError('No supported tables or columns were found in the configured database schema.', 'ADB_CATALOG_EMPTY');
  }

  let plannerResponse;
  try {
    plannerResponse = await getOpenRouterAnswer({
      systemPrompt: DB_PLANNER_SYSTEM_PROMPT,
      userContent: buildDbPlannerUserContent(cleanQuestion, getPublicAdbCatalog()),
      maxTokens: 500,
      tools: withOpenRouterDateTimeTool(),
      provider: { data_collection: 'deny' },
    });
  } catch (error) {
    // Do not log provider messages because they may echo part of the user's question.
    console.error('ADB query planner failed:', error?.name ?? 'unknown error');
    throw new DbAssistantError('The database question service is temporarily unavailable. Please try again later.', 'DB_PLANNER_FAILED');
  }

  let plan;
  try {
    const jsonText = plannerResponse
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    plan = JSON.parse(jsonText);
  } catch {
    throw new DbAssistantError('I could not map that question to an approved database query. Try rephrasing it with a dataset, filter, or date range.', 'DB_PLAN_INVALID');
  }

  try {
    const result = await executeAdbQuery(plan);
    return result.answer;
  } catch (error) {
    if (error instanceof AdbQueryPlanError) {
      console.warn('ADB query plan rejected:', error.message);
      throw new DbAssistantError('That question does not match an approved database query. Try specifying an available dataset and a supported filter.', 'DB_PLAN_REJECTED');
    }
    console.error('ADB query execution failed:', error.code ?? error.name);
    throw new DbAssistantError('The database query could not be completed. Check the question and try again.', 'ADB_QUERY_FAILED');
  }
}
