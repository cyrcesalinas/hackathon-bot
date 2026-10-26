const NOT_CONNECTED = 'Source discovery and summarization are not connected yet.';

function getOptionValue(options, name) {
  return options?.find((option) => option.name === name)?.value;
}

function getInputType(query) {
  const candidate = /^www\./i.test(query) ? `https://${query}` : query;

  try {
    const url = new URL(candidate);
    if (url.protocol === 'http:' || url.protocol === 'https:') return 'link';
  } catch {
    // Inputs that are not valid URLs are treated as topic names.
  }

  return 'topic';
}

/**
 * Handle the /research skeleton. It accepts a link or topic but does not
 * fetch pages, search the web, or generate a summary yet.
 */
export function handleResearchCommand(commandOptions = []) {
  const query = getOptionValue(commandOptions, 'query');
  if (typeof query !== 'string' || !query.trim()) {
    return 'Enter a URL or topic to research.';
  }

  const inputType = getInputType(query.trim());
  return `Research request received (${inputType}). ${NOT_CONNECTED}`;
}
