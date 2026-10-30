const MIN_FUZZY_LENGTH = 5;
const MAX_REFERENCE_LENGTH = 128;

export function normalizeCatalogReference(value) {
  if (typeof value !== 'string') return '';

  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_$#_]/g, '')
    .replace(/^_+|_+$/g, '');
}

function damerauLevenshtein(left, right) {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const distances = Array.from({ length: rows }, () => Array(columns).fill(0));

  for (let row = 0; row < rows; row += 1) distances[row][0] = row;
  for (let column = 0; column < columns; column += 1) distances[0][column] = column;

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      distances[row][column] = Math.min(
        distances[row - 1][column] + 1,
        distances[row][column - 1] + 1,
        distances[row - 1][column - 1] + substitutionCost,
      );

      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        distances[row][column] = Math.min(
          distances[row][column],
          distances[row - 2][column - 2] + 1,
        );
      }
    }
  }

  return distances[left.length][right.length];
}

function getEntryReferences(entry) {
  const references = [entry?.id, entry?.label];
  if (Array.isArray(entry?.aliases)) references.push(...entry.aliases);
  return [...new Set(references.map(normalizeCatalogReference).filter(Boolean))];
}

function getFuzzyThreshold(length) {
  if (length < MIN_FUZZY_LENGTH) return 0;
  return length <= 8 ? 1 : 2;
}

export function resolveCatalogEntry(entries, requestedReference) {
  if (!Array.isArray(entries) || typeof requestedReference !== 'string') return undefined;

  const exactMatch = entries.find((entry) => entry?.id === requestedReference);
  if (exactMatch) return exactMatch;

  const normalizedRequest = normalizeCatalogReference(requestedReference);
  if (!normalizedRequest || normalizedRequest.length > MAX_REFERENCE_LENGTH) return undefined;

  const normalizedMatches = entries.filter((entry) =>
    getEntryReferences(entry).includes(normalizedRequest),
  );
  if (normalizedMatches.length === 1) return normalizedMatches[0];
  if (normalizedMatches.length > 1) return undefined;

  let bestDistance = Number.POSITIVE_INFINITY;
  let bestMatches = [];

  for (const entry of entries) {
    const references = getEntryReferences(entry);
    if (!references.length) continue;

    const eligibleReferences = references.filter((reference) => {
      const threshold = getFuzzyThreshold(Math.max(normalizedRequest.length, reference.length));
      return threshold > 0 && Math.abs(normalizedRequest.length - reference.length) <= threshold;
    });
    if (!eligibleReferences.length) continue;

    const acceptedDistances = eligibleReferences
      .map((reference) => ({
        distance: damerauLevenshtein(normalizedRequest, reference),
        threshold: getFuzzyThreshold(Math.max(normalizedRequest.length, reference.length)),
      }))
      .filter(({ distance, threshold }) => distance <= threshold)
      .map(({ distance }) => distance);
    if (!acceptedDistances.length) continue;
    const distance = Math.min(...acceptedDistances);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatches = [entry];
    } else if (distance === bestDistance) {
      bestMatches.push(entry);
    }
  }

  return bestMatches.length === 1 ? bestMatches[0] : undefined;
}
