/**
 * Minimal JSON Schema (draft-07 subset) validator.
 *
 * The PTC workflow sandbox accepts only an object-rooted subset for structured
 * results, and we must validate the same documents on the host side before a
 * run starts. This module implements exactly the keywords we rely on, so a
 * template author gets a precise JSON-Pointer path instead of a vague failure.
 *
 * Supported: type, properties, required, additionalProperties(false|schema),
 * items, enum, const, minLength, maxLength, pattern, minimum, maximum, oneOf,
 * anyOf, default.
 */

const TYPE_CHECKS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};

export function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function escapePointer(segment) {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function join(path, segment) {
  return `${path}/${escapePointer(segment)}`;
}

/** Validate `value` against `schema`; returns a list of human-readable errors. */
export function validate(schema, value, path = '$') {
  if (schema === null || schema === undefined) return [];
  if (typeof schema !== 'object') return [`${path}: schema must be an object`];

  const errors = [];

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = jsonType(value);
    const matches = expected.some((type) => {
      const check = TYPE_CHECKS[type];
      if (!check) return true;
      if (type === 'number' && actual === 'integer') return true;
      if (type === 'integer' && actual === 'number' && Number.isInteger(value)) return true;
      return check(value);
    });
    if (!matches) {
      errors.push(`${path}: expected ${expected.join('|')}, got ${actual}`);
      return errors;
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.some((candidate) => candidate === value)) {
      errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((entry, index) => {
      errors.push(...validate(schema.items, entry, join(path, index)));
    });
  }

  if (TYPE_CHECKS.object(value) && (schema.properties || schema.required || schema.additionalProperties !== undefined)) {
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) errors.push(...validate(child, value[key], join(path, key)));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${path}: unexpected property "${key}"`);
      }
    } else if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
      for (const [key, entry] of Object.entries(value)) {
        if (!(key in properties)) {
          errors.push(...validate(schema.additionalProperties, entry, join(path, key)));
        }
      }
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const passed = schema.oneOf.filter((branch) => validate(branch, value, path).length === 0);
    if (passed.length !== 1) {
      errors.push(`${path}: must match exactly one of ${schema.oneOf.length} schemas (matched ${passed.length})`);
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const passed = schema.anyOf.filter((branch) => validate(branch, value, path).length === 0);
    if (passed.length === 0) {
      errors.push(`${path}: matches none of ${schema.anyOf.length} schemas`);
    }
  }

  return errors;
}

/** Fill absent properties from their schema defaults (one level, in place). */
export function applyDefaults(schema, value) {
  if (schema === null || typeof schema !== 'object') return value;
  if (!TYPE_CHECKS.object(value)) {
    if (schema.default !== undefined && value === undefined) return schema.default;
    return value;
  }
  const properties = schema.properties || {};
  for (const [key, child] of Object.entries(properties)) {
    if (!(key in value) && child && child.default !== undefined) {
      value[key] = child.default;
    }
  }
  return value;
}

/** Throw a single Error carrying every validation problem, for tool output. */
export function assertValid(schema, value, label = 'value') {
  const errors = validate(schema, value);
  if (errors.length > 0) {
    const error = new Error(`${label} failed schema validation:\n- ${errors.join('\n- ')}`);
    error.code = 'SCHEMA_INVALID';
    error.details = errors;
    throw error;
  }
  return value;
}
