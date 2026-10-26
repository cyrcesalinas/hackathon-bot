import 'dotenv/config';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

export function isOpenRouterConfigured() {
  return Boolean(
    process.env.OPENROUTER_API_KEY?.trim() &&
    process.env.OPENROUTER_MODEL?.trim(),
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

export async function getOpenRouterAnswer({
  systemPrompt,
  userContent,
  maxTokens = 900,
  tools,
  plugins,
}) {
  if (!isOpenRouterConfigured()) {
    throw new Error('OpenRouter configuration is missing');
  }

  const requestBody = {
    model: process.env.OPENROUTER_MODEL.trim(),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    max_tokens: maxTokens,
  };

  if (tools) requestBody.tools = tools;
  if (plugins) requestBody.plugins = plugins;

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
    throw new Error(`OpenRouter returned HTTP ${response.status}`);
  }

  const result = await response.json();
  const answer = getAnswerText(result.choices?.[0]?.message?.content);
  if (!answer) throw new Error('OpenRouter returned an empty answer');

  return answer;
}
