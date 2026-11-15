// Atelier Instruments — MIT License
// Strict parameter specs for agent and CLI callers. Safe in Node or the browser.
//
// The engines clamp and default quietly, which suits a panel but hides mistakes
// from an agent that cannot hear the result. A spec here rejects unknown keys,
// wrong types and out-of-range values with a message that names the field.

export class ParamError extends Error {
  constructor(problems) {
    super(problems.length === 1 ? problems[0] : `${problems.length} parameter problems:\n- ${problems.join("\n- ")}`);
    this.name = "ParamError";
    this.problems = problems;
  }
}

/** Number. Options: default, integer, description, optional. */
export function num(min, max, options = {}) {
  return { type: "number", min, max, ...options };
}

/** Boolean. */
export function bool(defaultValue, description) {
  return { type: "boolean", default: defaultValue, description };
}

/** One of a fixed set of strings or numbers. */
export function oneOf(values, defaultValue, description) {
  return { type: "enum", values: [...values], default: defaultValue, description };
}

/** String with a maximum length. */
export function str(maxLength, options = {}) {
  return { type: "string", maxLength, ...options };
}

/** Array of items. Options: min, max, default, description, optional. */
export function list(items, options = {}) {
  return { type: "array", items, ...options };
}

/** Object with known fields. Options: description, optional. */
export function obj(fields, options = {}) {
  return { type: "object", fields, ...options };
}

/** Number or a per-step array of numbers in the same range. */
export function numOrList(min, max, options = {}) {
  return { type: "numberOrArray", min, max, ...options };
}

function describePath(path) {
  return path || "params";
}

function check(spec, value, path, problems, partial = false) {
  if (value === undefined) {
    if (spec.default !== undefined) return clone(spec.default);
    if (spec.type === "object" && !spec.optional && !spec.required) return check(spec, {}, path, problems, partial);
    if (spec.required && !partial) problems.push(`${describePath(path)} is required${spec.description ? ` (${spec.description})` : ""}`);
    return undefined;
  }
  switch (spec.type) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        problems.push(`${path} must be a number, got ${JSON.stringify(value)}`);
        return undefined;
      }
      if (spec.integer && !Number.isInteger(value)) problems.push(`${path} must be a whole number, got ${value}`);
      if (value < spec.min || value > spec.max) problems.push(`${path} must be from ${spec.min} to ${spec.max}, got ${value}`);
      return value;
    }
    case "boolean":
      if (typeof value !== "boolean") problems.push(`${path} must be true or false, got ${JSON.stringify(value)}`);
      return value;
    case "enum":
      if (!spec.values.includes(value)) {
        problems.push(`${path} must be one of ${spec.values.map((v) => JSON.stringify(v)).join(", ")}, got ${JSON.stringify(value)}`);
      }
      return value;
    case "string":
      if (typeof value !== "string") problems.push(`${path} must be a string`);
      else if (value.length > spec.maxLength) problems.push(`${path} must be at most ${spec.maxLength} characters`);
      return value;
    case "numberOrArray": {
      if (Array.isArray(value)) {
        if (value.length < 1 || value.length > 64) problems.push(`${path} must have 1 to 64 entries`);
        return value.map((entry, i) => check({ type: "number", min: spec.min, max: spec.max }, entry, `${path}[${i}]`, problems, partial));
      }
      return check({ type: "number", min: spec.min, max: spec.max }, value, path, problems);
    }
    case "array": {
      if (!Array.isArray(value)) {
        problems.push(`${path} must be an array`);
        return undefined;
      }
      const min = spec.min ?? 0;
      const max = spec.max ?? Infinity;
      if (value.length < min || value.length > max) {
        problems.push(`${path} must have ${min} to ${max === Infinity ? "any number of" : max} entries, got ${value.length}`);
      }
      return value.map((entry, i) => check(spec.items, entry, `${path}[${i}]`, problems, partial));
    }
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        problems.push(`${describePath(path)} must be an object`);
        return undefined;
      }
      const out = {};
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(spec.fields, key)) {
          const known = Object.keys(spec.fields).join(", ");
          problems.push(`${path ? `${path}.` : ""}${key} is not a known field. Known fields: ${known}`);
        }
      }
      for (const [key, field] of Object.entries(spec.fields)) {
        const result = check(field, value[key], path ? `${path}.${key}` : key, problems, partial);
        if (result !== undefined) out[key] = result;
      }
      return out;
    }
    case "any":
      return value;
    default:
      throw new Error(`Unknown spec type ${spec.type}`);
  }
}

function clone(value) {
  return value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value;
}

/**
 * Validate input against an object spec. Returns the input with defaults filled in.
 * Throws ParamError listing every problem at once.
 * With partial true, missing required fields are allowed (for presets that the caller completes).
 */
export function validate(spec, input, { partial = false } = {}) {
  const problems = [];
  const value = check(spec, input ?? {}, "", problems, partial);
  if (problems.length) throw new ParamError(problems);
  return value;
}

/** JSON Schema (draft 2020-12 subset) for a spec, for MCP tool listings and docs. */
export function toJsonSchema(spec) {
  const base = {};
  if (spec.description) base.description = spec.description;
  if (spec.default !== undefined) base.default = clone(spec.default);
  switch (spec.type) {
    case "number":
      return { ...base, type: spec.integer ? "integer" : "number", minimum: spec.min, maximum: spec.max };
    case "boolean":
      return { ...base, type: "boolean" };
    case "enum":
      return { ...base, enum: spec.values };
    case "string":
      return { ...base, type: "string", maxLength: spec.maxLength };
    case "numberOrArray": {
      const item = { type: "number", minimum: spec.min, maximum: spec.max };
      return { ...base, anyOf: [item, { type: "array", items: item, minItems: 1, maxItems: 64 }] };
    }
    case "array": {
      const schema = { ...base, type: "array", items: toJsonSchema(spec.items) };
      if (spec.min) schema.minItems = spec.min;
      if (spec.max !== undefined && spec.max !== Infinity) schema.maxItems = spec.max;
      return schema;
    }
    case "object": {
      const properties = {};
      const required = [];
      for (const [key, field] of Object.entries(spec.fields)) {
        properties[key] = toJsonSchema(field);
        if (field.required) required.push(key);
      }
      const schema = { ...base, type: "object", properties, additionalProperties: false };
      if (required.length) schema.required = required;
      return schema;
    }
    case "any":
      return base;
    default:
      return base;
  }
}

/** Keep only keys the spec knows. Used to lift parameters out of preset files that carry extra metadata. */
export function pickKnown(spec, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out = {};
  for (const key of Object.keys(spec.fields)) {
    if (input[key] !== undefined) out[key] = clone(input[key]);
  }
  return out;
}
