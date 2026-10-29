const INLINE_RESPONSE_LIMIT = 1900;

function escapeDiscordMarkdown(value) {
  return String(value).replace(/([\\`*_{}\[\]()#+\-.!|>~])/g, '\\$1');
}

function getSafeMarkdownFilename(value) {
  const base = typeof value === 'string' ? value.replace(/\.md$/i, '') : '';
  const slug = base
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return `${slug || 'assistant-response'}.md`;
}

export function prepareDiscordResponse(answer, metadata = {}) {
  if (Array.from(answer).length <= INLINE_RESPONSE_LIMIT) {
    return { content: answer };
  }

  const title = escapeDiscordMarkdown(metadata.title || 'Response ready');
  const filename = getSafeMarkdownFilename(metadata.filename);
  return {
    content: `**${title}**\n\nThe complete response is attached below.`,
    components: [],
    attachment: {
      filename,
      description: metadata.description || 'Complete response in Markdown format',
      content: answer,
    },
  };
}
