const MATCHING_QUOTES = new Map([
  ['"', '"'],
  ["'", "'"],
  ['\u201c', '\u201d'],
  ['\u2018', '\u2019']
]);

export function cleanAirtableChoiceLabel(value) {
  let label = String(value ?? '').trim();

  // Old room data can contain serialized quote layers. Airtable treats those
  // quotes as part of the option name and attempts to create a new choice.
  for (let depth = 0; depth < 4 && label.length >= 2; depth += 1) {
    const expectedEnd = MATCHING_QUOTES.get(label[0]);
    if (!expectedEnd || label[label.length - 1] !== expectedEnd) break;
    label = label.slice(1, -1).trim();
  }

  return label;
}

function getChoiceNames(fieldMeta) {
  if (!['singleSelect', 'multipleSelects'].includes(fieldMeta?.type)) return [];
  return (fieldMeta?.options?.choices || [])
    .map((choice) => String(choice?.name ?? '').trim())
    .filter(Boolean);
}

function canonicalizeChoiceLabel(value, fieldMeta) {
  const cleaned = cleanAirtableChoiceLabel(value);
  if (!cleaned) return '';

  const normalized = cleaned.toLocaleLowerCase();
  const schemaChoice = getChoiceNames(fieldMeta).find(
    (choice) => cleanAirtableChoiceLabel(choice).toLocaleLowerCase() === normalized
  );
  return schemaChoice || cleaned;
}

export function normalizeAirtableChoiceValue(value, fieldMeta) {
  if (fieldMeta?.type === 'multipleSelects') {
    const values = Array.isArray(value) ? value : [value];
    return values
      .map((item) => canonicalizeChoiceLabel(item, fieldMeta))
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeChoiceLabel(item, fieldMeta));
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return canonicalizeChoiceLabel(value, fieldMeta);
  }
  return value;
}

export function normalizeAirtableMultipleChoiceValue(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((item) => cleanAirtableChoiceLabel(item))
    .filter(Boolean);
}

export function airtableMultipleChoiceErrorMatchesValue(errorText, value) {
  const error = String(errorText ?? '');
  if (!/INVALID_MULTIPLE_CHOICE_OPTIONS/i.test(error)) return false;

  const normalizedError = error.toLocaleLowerCase();
  return normalizeAirtableMultipleChoiceValue(value).some(
    (label) => normalizedError.includes(label.toLocaleLowerCase())
  );
}
