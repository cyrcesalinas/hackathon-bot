import 'dotenv/config';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

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
        content: systemPrompt,
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

  const result = await response.json();
  const choice = result.choices?.[0];
  const message = choice?.message;
  const answer = getAnswerText(message?.content);
  if (!answer) {
    const usage = result.usage ?? {};
    const diagnostics = {
      generationId: result.id ?? null,
      requestedModel: selectedModel,
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
    };
    console.error('OpenRouter returned no text:', JSON.stringify(diagnostics));
    throw new Error('OpenRouter returned an empty answer');
  }

  return answer;
}
