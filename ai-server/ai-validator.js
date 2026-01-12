const CANON_FIELDS = new Set([/*…*/]);
const ALLOWED_INTENTS = new Set(["count","list","sum","group_by","lookup"]);
const ALLOWED_ENTITIES = new Set(["rooms","buildings","floors"]);
const ALLOWED_OPS = new Set(["=","!=","in","contains",">",">=","<","<=","is_empty","not_empty"]);
const FIELD_TYPES = { /*…*/ };

const isPlainObject = (x) => x && typeof x === "object" && !Array.isArray(x);

export function validateAiQuery(q) { /* same logic */ }
export { CANON_FIELDS };
