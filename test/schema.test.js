import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, applyDefaults, assertValid } from '../src/schema.js';

test('required + additionalProperties:false', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['a'],
    properties: { a: { type: 'string' } },
  };
  assert.deepEqual(validate(schema, { a: 'x' }), []);
  const errors = validate(schema, { b: 1 });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /missing required property "a"/);
  assert.match(errors[1], /unexpected property "b"/);
});

test('nested index paths use JSON Pointer escaping', () => {
  const schema = {
    type: 'object',
    properties: {
      items: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    },
  };
  const errors = validate(schema, { items: [{ id: 'a' }, {}] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^\$\/items\/1: missing required property "id"/);
});

test('enum, const, pattern, minimum', () => {
  const schema = {
    type: 'object',
    properties: {
      mode: { enum: ['a', 'b'] },
      code: { const: 7 },
      slug: { type: 'string', pattern: '^[a-z]+$' },
      n: { type: 'integer', minimum: 2 },
    },
  };
  assert.deepEqual(validate(schema, { mode: 'a', code: 7, slug: 'abc', n: 2 }), []);
  const errors = validate(schema, { mode: 'c', code: 8, slug: 'AB', n: 1 });
  assert.equal(errors.length, 4);
});

test('integer accepts number with integral value, rejects 1.5', () => {
  assert.deepEqual(validate({ type: 'integer' }, 3), []);
  assert.equal(validate({ type: 'integer' }, 3.5).length, 1);
});

test('oneOf requires exactly one match', () => {
  const schema = { oneOf: [{ type: 'string' }, { type: 'number' }] };
  assert.deepEqual(validate(schema, 'x'), []);
  assert.deepEqual(validate(schema, 1), []);
  assert.equal(validate(schema, true).length, 1);
});

test('applyDefaults fills missing properties only', () => {
  const schema = {
    type: 'object',
    properties: { depth: { type: 'string', default: 'quick' }, other: { type: 'string' } },
  };
  assert.deepEqual(applyDefaults(schema, {}), { depth: 'quick' });
  assert.deepEqual(applyDefaults(schema, { depth: 'deep' }), { depth: 'deep' });
});

test('assertValid throws one error carrying every detail', () => {
  const schema = { type: 'object', required: ['a', 'b'] };
  assert.throws(
    () => assertValid(schema, {}, 'params'),
    (error) => error.code === 'SCHEMA_INVALID' && error.details.length === 2 && /params failed/.test(error.message),
  );
});
