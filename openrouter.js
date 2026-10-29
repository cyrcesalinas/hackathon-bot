import 'dotenv/config';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DATETIME_TOOL_TYPE = 'openrouter:datetime';
const DATETIME_SYSTEM_INSTRUCTION = 'When the request depends on the current date or time, call the openrouter:datetime tool and use its result. Interpret relative dates in the returned timezone. The datetime tool only verifies the current clock; use web research when external facts need verification.';

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

async function sendOpenRouterRequest(requestBody) {
  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(90_000),
  });

  if (!response.ok) {
    let detail = '';
    try {
      const errorBody = await response.json();
      const message = errorBody?.error?.message ?? errorBody?.message;
      if (typeof message === 'string') detail = message.slice(0, 300);
    } catch {
      // Preserve the status even when the provider returns a non-JSON error.
    }
    throw new Error(
      `OpenRouter returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    );
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
        content: Array.isArray(tools) && tools.some((tool) => tool?.type === DATETIME_TOOL_TYPE)
          ? `${systemPrompt}\n\n${DATETIME_SYSTEM_INSTRUCTION}`
          : systemPrompt,
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

  const initialResult = await sendOpenRouterRequest(requestBody);
  const initialInspection = inspectOpenRouterResult(initialResult, requestBody);
  if (initialInspection.answer) return initialInspection.answer;

  if (initialInspection.finishReason === 'length') {
    console.warn(
      'OpenRouter exhausted the output limit without text; retrying once with reasoning disabled:',
      JSON.stringify(initialInspection.diagnostics),
    );
    const retryRequestBody = {
      ...requestBody,
      reasoning: { enabled: false },
    };
    const retryResult = await sendOpenRouterRequest(retryRequestBody);
    const retryInspection = inspectOpenRouterResult(retryResult, retryRequestBody);
    if (retryInspection.answer) return retryInspection.answer;

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
