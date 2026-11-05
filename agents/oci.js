export const OCI_TOPICS = [
  { name: 'Oracle GoldenGate', value: 'goldengate', sources: ['https://docs.oracle.com/en-us/iaas/goldengate/'] },
  { name: 'Compute', value: 'compute', sources: ['https://docs.oracle.com/en-us/iaas/Content/Compute/home.htm'] },
  { name: 'Networking', value: 'networking', sources: ['https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/overview.htm'] },
  { name: 'Identity and Access Management', value: 'iam', sources: ['https://docs.oracle.com/en-us/iaas/Content/Identity/home.htm'] },
  { name: 'Object Storage', value: 'object-storage', sources: ['https://docs.oracle.com/en-us/iaas/Content/Object/Concepts/objectstorageoverview.htm'] },
  { name: 'Kubernetes (OKE)', value: 'kubernetes-oke', sources: ['https://docs.oracle.com/en-us/iaas/Content/ContEng/home.htm'] },
];

export function getOciTopic(value) {
  return OCI_TOPICS.find((topic) => topic.value === value);
}
