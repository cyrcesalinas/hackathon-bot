// Add only database views and columns that the bot is approved to expose.
// The model sees the semantic ids and descriptions below, never the SQL object
// names. SQL identifiers are always taken from this catalog, never from a plan.
//
// Example entry:
// {
//   id: 'work_items',
//   label: 'work items',
//   description: 'Approved view of support work items.',
//   source: { owner: 'BOT_DATA', name: 'V_WORK_ITEMS' },
//   allowUnfilteredList: false,
//   allowUnfilteredCount: false,
//   columns: [
//     {
//       id: 'status',
//       sqlName: 'STATUS',
//       label: 'Status',
//       description: 'Current work item status.',
//       type: 'text',
//       selectable: true,
//       filterOperators: ['eq', 'contains'],
//       sortable: true,
//       groupable: true,
//       aggregateFunctions: [],
//     },
//     {
//       id: 'created_at',
//       sqlName: 'CREATED_AT',
//       label: 'Created at',
//       description: 'Creation timestamp.',
//       type: 'date',
//       selectable: true,
//       filterOperators: ['gte', 'lte'],
//       sortable: true,
//       groupable: false,
//       aggregateFunctions: [],
//     },
//   ],
// }
//
// Use curated views and omit sensitive columns. Do not add base tables unless
// the bot's database user is separately restricted to those exact objects.
export const ADB_QUERY_CATALOG = [];
