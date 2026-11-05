export const AI_DB_TOPICS = [
  {
    name: 'Oracle AI Database',
    value: 'oracle-ai-database',
    sources: [
      'https://docs.oracle.com/en/database/oracle/oracle-database/26/ai.html',
      'https://docs.oracle.com/en-us/iaas/autonomous-database-serverless/doc/getting-started.html',
    ],
  },
  {
    name: 'Autonomous AI Lakehouse',
    value: 'autonomous-ai-lakehouse',
    sources: [
      'https://docs.oracle.com/en-us/iaas/autonomous-database-serverless/doc/autonomous-lakehouse.html',
      'https://www.oracle.com/autonomous-database/autonomous-ai-lakehouse/',
    ],
  },
  {
    name: 'Deep Trust AI Architecture',
    value: 'deep-trust-ai-architecture',
    sources: [
      'https://blogs.oracle.com/database/announcing-oracle-deep-trust-ai-architecture',
      'https://docs.oracle.com/en/database/oracle/oracle-database/26/ai.html',
    ],
  },
];

export function getAiDbTopic(value) {
  return AI_DB_TOPICS.find((topic) => topic.value === value);
}
