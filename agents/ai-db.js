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
  {
    name: 'AI Vector Search and RAG',
    value: 'ai-vector-search-rag',
    sources: [
      'https://docs.oracle.com/en/database/oracle/oracle-database/26/vecse/overview-ai-vector-search.html',
      'https://docs.oracle.com/en/database/oracle/oracle-database/26/selai/use-retrieval-augmented-generation-and-vectors.html',
    ],
    guidance: 'Explain embeddings, vector storage and indexes, semantic or hybrid retrieval, and how retrieved context is used in RAG. Separate database capabilities from external model-provider behavior.',
  },
  {
    name: 'Select AI',
    value: 'select-ai',
    sources: [
      'https://docs.oracle.com/en/database/oracle/oracle-database/26/selai/select-ai-about.html',
      'https://docs.oracle.com/en/database/oracle/oracle-database/26/selai/select-ai-features.html',
    ],
    guidance: 'Cover Select AI capabilities such as natural-language SQL, RAG, conversations, and database agents only where supported by the cited platform and release. Explain that generated SQL and its execution require appropriate permissions and review.',
  },
];

export function getAiDbTopic(value) {
  return AI_DB_TOPICS.find((topic) => topic.value === value);
}
