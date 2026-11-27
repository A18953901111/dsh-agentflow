import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectAnchors, normalizeText, verifyAnchors } from '../src/anchors.js';

test('normalizeText strips markup and decodes entities', () => {
  const html = '<p>Hello&nbsp;<b>world</b> &amp; <i>friends</i></p>\n<script>var x=1</script>';
  assert.equal(normalizeText(html), 'Hello world & friends');
});

test('collectAnchors walks nested results and dedupes', () => {
  const value = {
    steps: {
      gather: [
        { findings: [{ claim: 'a', url: 'https://a.example', quote: 'qa' }] },
        { findings: [{ claim: 'b', url: 'https://b.example', quote: 'qb' }] },
      ],
      verify: { verdicts: [] },
      write: { citations: [{ n: 1, url: 'https://a.example' }] },
    },
  };
  const anchors = collectAnchors(value);
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].url, 'https://a.example');
  assert.equal(anchors[1].claim, 'b');
});

test('collectAnchors caps the number it inspects', () => {
  const value = Array.from({ length: 60 }, (_, index) => ({ url: `https://x/${index}`, quote: `q${index}` }));
  assert.equal(collectAnchors(value, 10).length, 10);
});

test('verifyAnchors separates verified / mismatch / unreachable', async () => {
  const pages = {
    'https://ok.example': '<html><body><p>The  market grew  by 12% in 2026.</p></body></html>',
    'https://nope.example': '<html><body><p>Nothing relevant here.</p></body></html>',
  };
  const getPage = async (url) => {
    if (!(url in pages)) return { ok: false, reason: 'net-ENOTFOUND' };
    return { ok: true, text: pages[url], tls: 'strict' };
  };
  const anchors = [
    { url: 'https://ok.example', quote: 'market grew by 12%' },
    { url: 'https://nope.example', quote: 'the market shrank 40%' },
    { url: 'https://dead.example', quote: 'anything' },
    { url: 'ftp://bad.example', quote: 'anything' },
  ];

  const result = await verifyAnchors(anchors, { getPage, timeoutMs: 50 });
  assert.equal(result.total, 4);
  assert.equal(result.verified, 1);
  assert.equal(result.mismatch, 1);
  assert.equal(result.unreachable, 2);
  assert.equal(result.verified + result.mismatch + result.unreachable, result.total);
  assert.equal(result.coverage, 0.25);
  assert.equal(result.details[3].reason, 'unsupported-scheme');
});

test('an empty anchor set reports coverage null, not zero', async () => {
  const result = await verifyAnchors([], { getPage: async () => ({ ok: true, text: '' }) });
  assert.equal(result.total, 0);
  assert.equal(result.coverage, null);
});

test('an insecure fallback is recorded on the anchor it affected', async () => {
  const result = await verifyAnchors(
    [{ url: 'https://corp.example', quote: 'quoted line' }],
    { getPage: async () => ({ ok: true, text: '<p>a quoted line here</p>', tls: 'insecure' }) },
  );
  assert.equal(result.verified, 1);
  assert.equal(result.details[0].tls, 'insecure');
});
