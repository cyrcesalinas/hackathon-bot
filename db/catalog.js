// Populated at runtime from Oracle metadata. SQL identifiers come only from
// database metadata, never from the model-generated query plan.
export const ADB_QUERY_CATALOG = [];

export function replaceAdbQueryCatalog(entries) {
  ADB_QUERY_CATALOG.splice(0, ADB_QUERY_CATALOG.length, ...entries);
}
