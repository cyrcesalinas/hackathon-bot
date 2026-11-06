export const OCI_TOPICS = [
  { name: 'Oracle GoldenGate', value: 'goldengate', sources: ['https://docs.oracle.com/en-us/iaas/goldengate/'] },
  { name: 'Compute', value: 'compute', sources: ['https://docs.oracle.com/en-us/iaas/Content/Compute/home.htm'] },
  { name: 'Networking', value: 'networking', sources: ['https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/overview.htm'] },
  { name: 'Identity and Access Management', value: 'iam', sources: ['https://docs.oracle.com/en-us/iaas/Content/Identity/home.htm'] },
  { name: 'Object Storage', value: 'object-storage', sources: ['https://docs.oracle.com/en-us/iaas/Content/Object/Concepts/objectstorageoverview.htm'] },
  { name: 'Kubernetes (OKE)', value: 'kubernetes-oke', sources: ['https://docs.oracle.com/en-us/iaas/Content/ContEng/home.htm'] },
  {
    name: 'Generative AI and Agents',
    value: 'generative-ai-agents',
    sources: ['https://docs.oracle.com/en-us/iaas/Content/generative-ai/overview.htm'],
    guidance: 'Cover OCI-hosted model inference, embeddings, agent capabilities, and governance. Distinguish the managed OCI service from database-native AI features.',
  },
  {
    name: 'Serverless and Events',
    value: 'serverless-events',
    sources: [
      'https://docs.oracle.com/en-us/iaas/Content/Functions/Concepts/functionsconcepts.htm',
      'https://docs.oracle.com/en-us/iaas/Content/Events/Concepts/eventsoverview.htm',
      'https://docs.oracle.com/en-us/iaas/Content/APIGateway/Concepts/apigatewayoverview.htm',
    ],
    guidance: 'Explain event-driven designs using OCI Functions and Events. Include API Gateway only when relevant, and describe triggers and service interactions clearly.',
  },
  {
    name: 'Streaming and Messaging',
    value: 'streaming-messaging',
    sources: ['https://docs.oracle.com/en-us/iaas/Content/Streaming/Concepts/streamingoverview.htm'],
    guidance: 'Focus on OCI Streaming concepts such as streams, partitions, producers, consumers, ordering, retention, and Kafka compatibility when relevant.',
  },
  {
    name: 'Observability',
    value: 'observability',
    sources: ['https://docs.oracle.com/en-us/iaas/Content/cloud-adoption-framework/monitoring-and-observability.htm'],
    guidance: 'Explain how metrics, logs, events, alarms, and traces support monitoring and troubleshooting. Distinguish OCI services when describing an observability design.',
  },
  {
    name: 'Security and Secrets',
    value: 'security-secrets',
    sources: [
      'https://docs.oracle.com/en-us/iaas/Content/Security/Concepts/security_overview.htm',
      'https://docs.oracle.com/en-us/iaas/Content/KeyManagement/Concepts/keyoverview.htm',
    ],
    guidance: 'Explain the OCI shared responsibility model and relevant IAM, encryption, Vault, key, or secret controls. Do not imply a service feature is enabled by default unless the docs confirm it.',
  },
];

export function getOciTopic(value) {
  return OCI_TOPICS.find((topic) => topic.value === value);
}
