export const PRIVATE_TABLES = ['PERSON_NOTES', 'PERSON_NOTE_SCOPES', 'USER_MEMORIES', 'USER_MEMORY_SCOPES'];
export function isPrivateTable(name) {
  return typeof name === 'string' && PRIVATE_TABLES.includes(name.replaceAll('"', '').split('.').at(-1).toUpperCase());
}
export function assertPublicSql(sql) {
  if (PRIVATE_TABLES.some((name) => new RegExp(`\\b${name}\\b`, 'i').test(sql))) throw new Error('ADB_PRIVATE_TABLE');
}
