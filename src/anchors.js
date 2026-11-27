/**
 * Citation anchoring.
 *
 * The proposal's weak point was "cross-validation that is really mutual
 * copying". This module is the mechanical half of the answer: every claim the
 * workflow emits carries `{ url, quote }`, and the host fetches the source and
 * checks the quote is actually there. No model is consulted.
 *
 * Fetching uses node:https rather than global fetch so the TLS policy is
 * explicit: `strict` verifies certificates, `insecure` skips verification, and
 * `auto` (default) retries once without verification when the chain is not
 * trusted — the common case behind a TLS-intercepting proxy — and records that
 * fact on every anchor it affects.
 */
import http from 'node:http';
import https from 'node:https';

const MAX_ANCHORS = 40;
const MAX_REDIRECTS = 3;

const HTML_ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

/** Walk a result value and collect every `{url, quote}` pair, depth-capped. */
export function collectAnchors(value, limit = MAX_ANCHORS) {
  const out = [];
  const seen = new Set();

  (function walk(node, depth) {
    if (out.length >= limit || depth > 8 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth + 1);
      return;
    }
    const url = typeof node.url === 'string' ? node.url.trim() : '';
    const quote = typeof node.quote === 'string' ? node.quote : '';
    if (url.length > 0 && quote.trim().length > 0) {
      const key = `${url}\u0000${quote}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ claim: typeof node.claim === 'string' ? node.claim : null, url, quote });
      }
    }
    for (const child of Object.values(node)) walk(child, depth + 1);
  })(value, 0);

  return out;
}

/** Strip tags/entities and collapse whitespace so quotes survive HTML noise. */
export function normalizeText(input) {
  let text = String(input ?? '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  for (const [entity, replacement] of Object.entries(HTML_ENTITIES)) {
    text = text.split(entity).join(replacement);
  }
  return text.replace(/\s+/g, ' ').trim();
}

function requestOnce(url, { timeoutMs, maxBytes, rejectUnauthorized }) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const request = client.request(
      url,
      {
        method: 'GET',
        rejectUnauthorized,
        headers: { 'user-agent': 'AgentFlow/0.2 (+citation check)', accept: 'text/html,application/xhtml+xml' },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          resolve({ redirect: new URL(response.headers.location, url).toString() });
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          resolve({ ok: false, reason: `http-${status}` });
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size <= maxBytes) chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8').slice(0, maxBytes) });
        });
        response.on('error', (error) => resolve({ ok: false, reason: `stream-${error.code ?? 'error'}` }));
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('ETIMEDOUT'));
    });
    request.on('error', (error) => {
      resolve({ ok: false, reason: error?.code === 'ETIMEDOUT' ? 'timeout' : `net-${error?.code ?? 'error'}`, cert: error?.code === 'SELF_SIGNED_CERT_IN_CHAIN' || /certificate/i.test(String(error?.message)) });
    });
    request.end();
  });
}

/**
 * Fetch one page. `tls` is 'strict' | 'insecure' | 'auto'.
 * Returns { ok, text, tls } or { ok: false, reason }.
 */
export async function fetchPage(url, { timeoutMs = 10000, maxBytes = 2_000_000, tls = 'auto' } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported-scheme' };
  }

  const attempt = async (rejectUnauthorized, label) => {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await requestOnce(current, { timeoutMs, maxBytes, rejectUnauthorized });
      if (response.redirect) {
        current = response.redirect;
        continue;
      }
      return { ...response, tls: label };
    }
    return { ok: false, reason: 'too-many-redirects' };
  };

  if (tls === 'insecure') return attempt(false, 'insecure');
  const strict = await attempt(true, 'strict');
  if (strict.ok || !strict.cert || tls === 'strict') return strict;
  const relaxed = await attempt(false, 'insecure');
  return relaxed.ok ? { ...relaxed, tls: 'insecure' } : strict;
}

/**
 * Verify anchors against their sources.
 * Returns counts plus per-anchor detail; `verified + mismatch + unreachable`
 * equals `total` so the report can never silently lose an anchor.
 */
export async function verifyAnchors(anchors, options = {}) {
  const {
    getPage = (url) => fetchPage(url, { timeoutMs, maxBytes, tls }),
    timeoutMs = 10000,
    maxBytes = 2_000_000,
    tls = 'auto',
  } = options;

  const pages = new Map();
  const details = [];
  let verified = 0;
  let mismatch = 0;
  let unreachable = 0;

  for (const anchor of anchors) {
    // Scheme validation lives here as well as in fetchPage, so an injected
    // fetcher cannot make a non-http anchor look reachable.
    let scheme = null;
    try {
      scheme = new URL(anchor.url).protocol;
    } catch {
      scheme = null;
    }
    if (scheme !== 'http:' && scheme !== 'https:') {
      unreachable += 1;
      details.push({ ...anchor, status: 'unreachable', reason: scheme ? 'unsupported-scheme' : 'invalid-url' });
      continue;
    }

    let page = pages.get(anchor.url);
    if (page === undefined) {
      page = await getPage(anchor.url);
      pages.set(anchor.url, page);
    }

    if (!page.ok) {
      unreachable += 1;
      details.push({ ...anchor, status: 'unreachable', reason: page.reason });
      continue;
    }

    const haystack = normalizeText(page.text);
    const needle = normalizeText(anchor.quote);
    const head = needle.slice(0, 60);
    const found = haystack.includes(needle) || (head.length >= 20 && haystack.includes(head));
    if (found) {
      verified += 1;
      details.push({ ...anchor, status: 'verified', ...(page.tls === 'insecure' ? { tls: 'insecure' } : {}) });
    } else {
      mismatch += 1;
      details.push({ ...anchor, status: 'mismatch', reason: 'quote-not-found' });
    }
  }

  return {
    total: anchors.length,
    verified,
    mismatch,
    unreachable,
    coverage: anchors.length === 0 ? null : Number((verified / anchors.length).toFixed(3)),
    details,
  };
}
