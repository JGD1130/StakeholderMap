const CANON_FIELDS = new Set([
  "Number","RevitId","Revit_UniqueId","Floor","LevelName","Area_SF","Room Type",
  "NCES_Category_Desc","Department","NCES_Occupancy Status","NCES_Seat Count","Comments"
]);

const ALLOWED_INTENTS = new Set(["count", "list", "sum", "group_by", "lookup"]);
const ALLOWED_ENTITIES = new Set(["rooms"]);
const ALLOWED_OPS = new Set(["=", "!=", "in", "contains", ">", ">=", "<", "<=", "is_empty", "not_empty"]);

function isPlainObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

export function validateAiQuery(q) {
  const errors = [];

  if (!isPlainObject(q)) return { ok: false, errors: ["Query must be a JSON object."] };

  if (!ALLOWED_INTENTS.has(q.intent)) errors.push(`Invalid intent: ${q.intent}`);
  if (!ALLOWED_ENTITIES.has(q.entity)) errors.push(`Invalid entity: ${q.entity}`);

  if (q.filters != null) {
    if (!Array.isArray(q.filters)) {
      errors.push("filters must be an array.");
    } else {
      q.filters.forEach((f, i) => {
        if (!isPlainObject(f)) return errors.push(`filters[${i}] must be an object.`);
        const { field, op, value } = f;

        if (!CANON_FIELDS.has(field)) errors.push(`filters[${i}].field not allowed: ${field}`);
        if (!ALLOWED_OPS.has(op)) errors.push(`filters[${i}].op not allowed: ${op}`);

        if (op === "in") {
          if (!Array.isArray(value)) errors.push(`filters[${i}].value must be an array for op "in".`);
        } else if (op === "is_empty" || op === "not_empty") {
          if (value != null) errors.push(`filters[${i}].value must be null/omitted for op "${op}".`);
        } else {
          if (value == null) errors.push(`filters[${i}].value required for op "${op}".`);
        }
      });
    }
  }

  if (q.group_by != null) {
    if (!Array.isArray(q.group_by)) errors.push("group_by must be an array.");
    else q.group_by.forEach((f, i) => {
      if (!CANON_FIELDS.has(f)) errors.push(`group_by[${i}] field not allowed: ${f}`);
    });
  }

  if (q.limit != null && (typeof q.limit !== "number" || q.limit < 0 || q.limit > 5000)) {
    errors.push("limit must be a number between 0 and 5000.");
  }

  return { ok: errors.length === 0, errors };
}
