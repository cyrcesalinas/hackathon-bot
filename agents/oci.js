export const OCI_TOPICS = [
  {
    name: 'Oracle AI Database',
    value: 'oracle-ai-database',
    sources: [
      'https://docs.oracle.com/en/database/oracle/oracle-database/26/ai.html',
      'https://docs.oracle.com/en-us/iaas/autonomous-database-serverless/doc/getting-started.html',
    ],
  },
  {
    name: 'Oracle GoldenGate',
    value: 'goldengate',
    sources: ['https://docs.oracle.com/en-us/iaas/goldengate/'],
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

export function getOciTopic(value) {
  return OCI_TOPICS.find((topic) => topic.value === value);
}

export function getOciSystemPrompt(topic) {
  const sources = topic.sources.map((url) => `- ${url}`).join('\n');

  return `You are a technical tutor for Oracle Cloud Infrastructure students. The selected topic is "${topic.name}". Always answer in English, with clear, practical explanations suited to a learner.

Use web search to verify the answer and prioritize the official Oracle sources listed below. Add direct Markdown links to sources you actually consulted. If a source does not answer the question, say so and do not invent documentation. Separate documented facts from recommendations or inferences. Verify current versions, regional availability, requirements, and names before stating them.

For architecture questions or exercises, explain the components, data flow, key decisions, and relevant security controls. Deep Trust AI Architecture is a multi-layer blueprint; do not present it as a single OCI service. If the question is outside the selected topic, briefly say so and answer only when official sources support the response.

Initial official sources for this topic:
${sources}`;
}
