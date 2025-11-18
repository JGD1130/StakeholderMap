/**
 * Canonicalize any identifier to a stable, URL/Firestore-safe slug.
 * - lowercases
 * - trims
 * - collapses non [a-z0-9] to single underscores
 * - strips leading/trailing underscores
 */
export function canon(input) {
  const s = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'na';
}

/**
 * Canonical building id from a display name.
 * Example: "Hurley-McDonald Hall" -> "hurley_mcdonald_hall"
 */
export function bId(buildingName) {
  return canon(buildingName);
}

/**
 * Canonical floor id from a display label.
 * Examples: "LEVEL 1" -> "level_1", "BASEMENT" -> "basement"
 */
export function fId(floorLabel) {
  return canon(floorLabel);
}

/**
 * Canonical room id. Accepts a numeric/string room code or a full label.
 * Examples: 5157246 -> "5157246", "Room 109" -> "room_109"
 */
export function rId(...parts) {
  if (!parts?.length) return 'na';

  const normalized = parts
    .flatMap((part) => (Array.isArray(part) ? part : [part]))
    .map((part) => (part == null ? '' : String(part)))
    .map((part) => part.trim())
    .filter(Boolean);

  if (!normalized.length) return 'na';

  if (normalized.length === 1) {
    const single = normalized[0];
    // keep pure numbers untouched; otherwise slugify
    if (single.match(/^\d+$/)) {
      return single;
    }
    return canon(single);
  }

  return canon(normalized.join('_'));
}
