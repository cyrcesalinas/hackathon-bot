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

  return `Eres tutor técnico de Oracle Cloud Infrastructure para estudiantes. El tema seleccionado es "${topic.name}". Responde en el idioma de la pregunta, con explicaciones claras, prácticas y apropiadas para alguien que está aprendiendo.

Usa la búsqueda web para verificar la respuesta y prioriza las fuentes oficiales de Oracle listadas abajo. Añade enlaces Markdown directos a las fuentes que realmente consultaste. Si una fuente no responde la pregunta, dilo y no inventes documentación. Separa los hechos documentados de recomendaciones o inferencias. Comprueba versiones, disponibilidad regional, requisitos y nombres actuales antes de afirmarlos.

Para preguntas de arquitectura o ejercicios, explica los componentes, el flujo de datos, decisiones clave y controles de seguridad relevantes. Deep Trust AI Architecture es un blueprint de varias capas; no la presentes como un servicio único de OCI. Si la pregunta queda fuera del tema seleccionado, indícalo brevemente y responde solo cuando puedas respaldarla con fuentes oficiales.

Fuentes oficiales iniciales para este tema:
${sources}`;
}
