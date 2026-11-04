import { personNotes } from './db/person-notes.js';
import { memoryContext } from './user-memory.js';

export const MEMORY_COMMAND = {
  name: 'memory', description: 'Privately manage your personal notes in this exact channel',
  type: 1, integration_types: [0, 1], contexts: [0, 1, 2],
  options: [
    { name: 'action', description: 'List your latest 40 notes, delete one, or clear this channel', type: 3, required: true,
      choices: [{ name: 'List notes', value: 'list' }, { name: 'Delete a note', value: 'delete' }, { name: 'Clear notes in this channel', value: 'clear' }] },
    { name: 'id', description: 'Note ID from /memory list; required for delete', type: 3, required: false, max_length: 36 },
  ],
};

export const isMemoryCommand = (data) => data?.name === 'memory';

export async function runMemoryCommand(event, { store = personNotes } = {}) {
  const context = memoryContext(event);
  const option = (name) => event.data?.options?.find((entry) => entry.name === name)?.value;
  const action = option('action');
  if (!['list', 'delete', 'clear'].includes(action)) return 'Choose list, delete, or clear.';
  const id = option('id');
  if (action === 'delete' && (typeof id !== 'string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id))) return 'Enter a valid note ID from /memory list.';
  await store.getRevision(context);
  if (action === 'list') {
    const notes = await store.list(context);
    if (!notes.length) return 'There are no personal notes for you in this channel.';
    return ['Your latest 40 personal notes in this channel (newest first):', ...notes.map((note) =>
      `\nID: ${note.id}\nDate: ${new Date(note.createdAt).toISOString()}\n${note.note}`),
    '\nOlder notes remain stored until deleted. To correct a fact, delete the old note and state the correction.'].join('\n');
  }
  const count = await store.remove(context, action === 'delete' ? id : undefined);
  return action === 'delete' ? (count ? 'Note deleted.' : 'That note was not found in your current channel.')
    : `Deleted ${count} personal notes from your current channel.`; 
}
