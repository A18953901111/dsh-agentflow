import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractMarkdown } from '../src/runtime.js';

test('extractMarkdown finds prose in any step, not just "write"', () => {
  assert.equal(extractMarkdown({ markdown: '# top' }), '# top');
  assert.equal(extractMarkdown({ steps: { write: { markdown: '# w' } } }), '# w');
  // codebase-audit's prose step is called `report`; a hardcoded steps.write lookup lost it.
  assert.equal(extractMarkdown({ steps: { report: { markdown: '# r' } } }), '# r');
});

test('extractMarkdown ignores empty or malformed values', () => {
  assert.equal(extractMarkdown(null), null);
  assert.equal(extractMarkdown({ steps: {} }), null);
  assert.equal(extractMarkdown({ steps: { report: { markdown: '   ' } } }), null);
  assert.equal(extractMarkdown({ steps: { report: { counts: { high: 1 } } } }), null);
});
