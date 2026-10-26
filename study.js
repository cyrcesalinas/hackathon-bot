const NOT_CONNECTED = 'The Study Assistant is a command skeleton; AI generation is not connected yet.';
const FILES_NOT_READY = 'Files are not processed or saved by this bot yet.';

function getOptionValue(options, name) {
  return options?.find((option) => option.name === name)?.value;
}

/**
 * Return a placeholder response for a /study subcommand.
 * File attachments are intentionally not downloaded, processed, or persisted.
 */
export function handleStudyCommand(commandOptions = []) {
  const subcommand = commandOptions[0];
  const options = subcommand?.options ?? [];

  if (subcommand?.name === 'ask') {
    const question = getOptionValue(options, 'question');
    if (!question) return 'Please include a study question.';
    return `${NOT_CONNECTED} Your question was not sent to an AI provider.`;
  }

  if (subcommand?.name === 'upload') {
    const file = getOptionValue(options, 'file');
    if (!file) return 'Please attach a study file.';
    return `The upload command is wired, but ${FILES_NOT_READY}`;
  }

  if (subcommand?.name === 'exam' || subcommand?.name === 'guide') {
    const topic = getOptionValue(options, 'topic')?.trim();
    const file = getOptionValue(options, 'file');
    if (!topic && !file) return 'Provide a topic or attach a file to continue.';

    const outputType = subcommand.name === 'exam' ? 'Practice exam' : 'Study guide';
    const fileNote = file ? ` ${FILES_NOT_READY}` : '';
    return `${outputType} generation is not connected yet.${fileNote}`;
  }

  return null;
}
