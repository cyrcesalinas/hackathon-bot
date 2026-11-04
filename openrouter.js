import 'dotenv/config';
import { buildSystemPromptWithDateTime, CONTINUATION_INSTRUCTION } from './prompts.js';
import { runAppToolLoop } from './app-tools.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DATETIME_TOOL_TYPE = 'openrouter:datetime';
const MAX_CONTINUATION_REQUESTS = 2;

function getDateTimeTimezone() {
  const configuredTimezone = process.env.OPENROUTER_DATETIME_TIMEZONE?.trim() || 'America/New_York';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: configuredTimezone });
    return configuredTimezone;
  } catch {
    console.warn('Invalid OPENROUTER_DATETIME_TIMEZONE; using America/New_York.');
    return 'America/New_York';
  }
}

export function withOpenRouterDateTimeTool(tools) {
  const requestTools = Array.isArray(tools) ? [...tools] : [];
  if (requestTools.some((tool) => tool?.type === DATETIME_TOOL_TYPE)) return requestTools;

  requestTools.push({
    type: DATETIME_TOOL_TYPE,
    parameters: { timezone: getDateTimeTimezone() },
  });
  return requestTools;
}

export function getOpenRouterModel(purpose = 'default') {
  if (purpose === 'study') {
    return process.env.OPENROUTER_STUDY_MODEL?.trim() || process.env.OPENROUTER_MODEL?.trim() || '';
  }
  return process.env.OPENROUTER_MODEL?.trim() || '';
}

export function isOpenRouterConfigured(model = getOpenRouterModel()) {
  return Boolean(
    process.env.OPENROUTER_API_KEY?.trim() &&
    typeof model === 'string' &&
    model.trim(),
  );
}

function getAnswerText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function getContentDiagnostics(content) {
  if (typeof content === 'string') {
    return { contentType: 'string', textLength: content.length };
  }
  if (Array.isArray(content)) {
    return {
      contentType: 'array',
      contentBlockTypes: content.slice(0, 8).map((part) =>
        typeof part?.type === 'string' ? part.type : 'unknown',
      ),
    };
  }
  return { contentType: content === null ? 'null' : typeof content };
}

async function sendOpenRouterRequest(requestBody, { deadline } = {}) {
  const remaining = Math.min(90_000, (deadline || Infinity) - Date.now());
  if (remaining <= 0) throw new Error('OPENROUTER_DEADLINE');
  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(Math.ceil(remaining)),
  });

  if (!response.ok) {
    // Provider error bodies may echo personal notes or credentials.
    throw new Error(`OpenRouter returned HTTP ${response.status}`);
  }

  return response.json();
}

function inspectOpenRouterResult(result, requestBody) {
  const choice = result.choices?.[0];
  const message = choice?.message;
  const usage = result.usage ?? {};
  return {
    answer: getAnswerText(message?.content),
    finishReason: choice?.finish_reason ?? null,
    diagnostics: {
      generationId: result.id ?? null,
      requestedModel: requestBody.model,
      responseModel: result.model ?? null,
      provider: result.provider ?? null,
      finishReason: choice?.finish_reason ?? null,
      maxTokens: requestBody.max_tokens,
      promptTokens: usage.prompt_tokens ?? null,
      completionTokens: usage.completion_tokens ?? null,
      reasoningTokens:
        usage.completion_tokens_details?.reasoning_tokens ??
        usage.reasoning_tokens ??
        null,
      ...getContentDiagnostics(message?.content),
      messageFields: message && typeof message === 'object'
        ? Object.keys(message).slice(0, 12)
        : [],
    },
  };
}

function discardIncompleteFinalLine(answer) {
  const lastNewline = answer.lastIndexOf('\n');
  if (lastNewline < 0) return answer;
  const finalLine = answer.slice(lastNewline + 1).trimEnd();
  if (/[.!?:;|>`}\])”’"]$/.test(finalLine)) return answer;
  const completeLines = answer.slice(0, lastNewline).trimEnd();
  return completeLines || answer;
}

async function continueLengthLimitedAnswer(
  initialAnswer,
  requestBody,
  maxContinuations,
  resolvedModel,
  deadline,
) {
  const continuationLimit = Math.min(
    MAX_CONTINUATION_REQUESTS,
    Math.max(0, Number.isInteger(maxContinuations) ? maxContinuations : 0),
  );
  let answer = discardIncompleteFinalLine(initialAnswer);
  let attempts = 0;
  let continuationFailed = false;

  for (let continuation = 1; continuation <= continuationLimit; continuation += 1) {
    attempts = continuation;
    const continuationRequestBody = {
      ...requestBody,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      messages: [
        ...requestBody.messages,
        { role: 'assistant', content: answer },
        { role: 'user', content: CONTINUATION_INSTRUCTION },
      ],
      reasoning: { enabled: false },
      ...(requestBody.tools?.some((tool) => tool.type === 'function') ? { tool_choice: 'none' } : {}),
    };
    let result;
    try {
      result = await sendOpenRouterRequest(continuationRequestBody, { deadline });
    } catch (error) {
      continuationFailed = true;
      console.error('OpenRouter continuation failed; preserving the partial answer:', JSON.stringify({
        requestedModel: continuationRequestBody.model,
        continuation,
        continuationLimit,
        error: error?.message ?? 'unknown error',
      }));
      if (continuation < continuationLimit) continue;
      break;
    }
    continuationFailed = false;
    const inspection = inspectOpenRouterResult(result, continuationRequestBody);

    console.warn('OpenRouter continued a length-limited response:', JSON.stringify({
      ...inspection.diagnostics,
      continuation,
      continuationLimit,
    }));

    if (!inspection.answer) {
      if (inspection.finishReason === 'length') continue;
      console.error('OpenRouter returned no text while continuing a response:', JSON.stringify({
        ...inspection.diagnostics,
        continuation,
      }));
      break;
    }

    answer = `${answer}\n${inspection.answer}`;
    if (inspection.finishReason !== 'length') return answer;
    answer = discardIncompleteFinalLine(answer);
  }

  const attemptLabel = attempts === 1 ? 'attempt' : 'attempts';
  if (continuationFailed) {
    return `${answer}\n\n> ⚠️ A continuation request failed after ${attempts} continuation ${attemptLabel}. The completed text above was preserved, but the response may still be incomplete.`;
  }
  return `${answer}\n\n> ⚠️ This response reached the maximum output length after ${attempts} continuation ${attemptLabel} and may still be incomplete.`;
}

export async function getOpenRouterAnswer({
  systemPrompt,
  userContent,
  maxTokens = 900,
  model,
  tools,
  plugins,
  provider,
  responseFormat,
  reasoning,
  maxContinuations = 0,
  appTools,
  deadline = Date.now() + 120_000,
}) {
  const selectedModel = typeof model === 'string' && model.trim()
    ? model.trim()
    : getOpenRouterModel();
  if (!isOpenRouterConfigured(selectedModel)) {
    throw new Error('OpenRouter configuration is missing');
  }

  const requestBody = {
    model: selectedModel,
    messages: [
      {
        role: 'system',
        content: buildSystemPromptWithDateTime(
          systemPrompt,
          Array.isArray(tools) && tools.some((tool) => tool?.type === DATETIME_TOOL_TYPE),
        ),
      },
      { role: 'user', content: userContent },
    ],
    max_tokens: maxTokens,
  };

  if (Array.isArray(tools) && tools.length) requestBody.tools = tools;
  if (plugins) requestBody.plugins = plugins;
  if (provider) requestBody.provider = provider;
  if (responseFormat) requestBody.response_format = responseFormat;
  if (reasoning) requestBody.reasoning = reasoning;
  const hasAppTools = appTools && Object.keys(appTools).length > 0;
  if (hasAppTools) {
    requestBody.tools = [...(requestBody.tools || []), ...Object.values(appTools).map((tool) => tool.definition)];
    requestBody.tool_choice = 'auto';
    // Handlers execute sequentially in runAppToolLoop. Avoid requiring the
    // optional parallel_tool_calls parameter, which some tool-capable models
    // do not support at any endpoint.
    requestBody.provider = { ...requestBody.provider, data_collection: 'deny', require_parameters: true };
  }

  const initialResult = hasAppTools
    ? await runAppToolLoop(requestBody, appTools, (body) => sendOpenRouterRequest(body, { deadline }), { deadline })
    : await sendOpenRouterRequest(requestBody, { deadline });
  const initialInspection = inspectOpenRouterResult(initialResult, requestBody);
  if (initialInspection.answer) {
    if (initialInspection.finishReason === 'length' && maxContinuations > 0) {
      return continueLengthLimitedAnswer(
        initialInspection.answer,
        requestBody,
        maxContinuations,
        initialInspection.diagnostics.responseModel,
        deadline,
      );
    }
    return initialInspection.answer;
  }

  if (initialInspection.finishReason === 'length') {
    console.warn(
      'OpenRouter exhausted the output limit without text; retrying once with reasoning disabled:',
      JSON.stringify(initialInspection.diagnostics),
    );
    const retryRequestBody = {
      ...requestBody,
      reasoning: { enabled: false },
      ...(hasAppTools ? { tool_choice: 'none' } : {}),
    };
    const retryResult = await sendOpenRouterRequest(retryRequestBody, { deadline });
    const retryInspection = inspectOpenRouterResult(retryResult, retryRequestBody);
    if (retryInspection.answer) {
      if (retryInspection.finishReason === 'length' && maxContinuations > 0) {
        return continueLengthLimitedAnswer(
          retryInspection.answer,
          retryRequestBody,
          maxContinuations,
          retryInspection.diagnostics.responseModel,
          deadline,
        );
      }
      return retryInspection.answer;
    }

    console.error('OpenRouter returned no text after retry:', JSON.stringify({
      ...retryInspection.diagnostics,
      reasoningDisabled: true,
      initialGenerationId: initialInspection.diagnostics.generationId,
    }));
  } else {
    console.error('OpenRouter returned no text:', JSON.stringify(initialInspection.diagnostics));
  }

  throw new Error('OpenRouter returned an empty answer');
}
