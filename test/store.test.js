import { test } from 'node:test';
import { removeDir } from './_cleanup.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore, newRunId } from '../src/store.js';

async function withStore(fn) {
  const root = await mkdtemp(join(tmpdir(), 'agentflow-store-'));
  try {
    return await fn(createStore(root), root);
  } finally {
    await removeDir(root);
  }
}

test('run ids are unique and path-safe', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newRunId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^run_[0-9a-f]{8}$/);
});

test('writes run.json, extra artifacts and an index entry', async () => {
  await withStore(async (store) => {
    const runId = newRunId();
    await store.writeRun(runId, { runId, status: 'completed' });
    await store.writeText(runId, 'trace.jsonl', '{"seq":0}\n');
    await store.record({ runId, template: 't', status: 'completed', durationMs: 12 });

    const record = await store.read(runId);
    assert.equal(record.status, 'completed');
    const trace = await readFile(join(store.dirOf(runId), 'trace.jsonl'), 'utf8');
    assert.match(trace, /seq/);
    const index = await store.list();
    assert.equal(index.length, 1);
    assert.equal(index[0].runId, runId);
  });
});

test('index keeps the newest 50 runs and de-duplicates by id', async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 60; i += 1) {
      await store.record({ runId: `run_${i.toString().padStart(8, '0')}`, template: 't', status: 'completed' });
    }
    const list = await store.list(100);
    assert.equal(list.length, 50);
    assert.equal(list[0].runId, 'run_00000059');

    await store.record({ runId: 'run_00000059', template: 't', status: 'failed' });
    const again = await store.list(100);
    assert.equal(again.length, 50);
    assert.equal(again[0].status, 'failed');
  });
});

test('concurrent record() calls keep every entry', async () => {
  await withStore(async (store) => {
    const ids = Array.from({ length: 8 }, () => newRunId());
    // Without the serial queue these interleave read-modify-write and the last
    // writer wins with a stale snapshot.
    await Promise.all(ids.map((runId) => store.record({ runId, template: 't', status: 'completed' })));
    const list = await store.list(100);
    assert.equal(list.length, 8);
    assert.deepEqual(new Set(list.map((entry) => entry.runId)), new Set(ids));
  });
});

test('a corrupt index is rebuilt from run.json instead of losing history', async () => {
  await withStore(async (store, root) => {
    const first = newRunId();
    const second = newRunId();
    await store.writeRun(first, { runId: first, template: 'a', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', durationMs: 1, agentsStarted: 1 });
    await store.writeRun(second, { runId: second, template: 'b', status: 'error', startedAt: '2026-01-02T00:00:00.000Z', durationMs: 2, agentsStarted: 2 });
    await writeFile(join(root, 'index.json'), '{not json', 'utf8');

    const list = await store.list(10);
    assert.deepEqual(list.map((entry) => entry.runId), [second, first], 'newest first, rebuilt from run.json');

    const files = await readdir(root);
    assert.ok(
      files.some((name) => name.startsWith('index.json.corrupt-')),
      'the unreadable index is kept for diagnosis, not overwritten',
    );

    // record() merges into the rebuilt index instead of a fake empty one.
    const third = newRunId();
    await store.record({ runId: third, template: 'c', status: 'completed' });
    assert.equal((await store.list(10)).length, 3);
  });
});

test('two store instances on one root serialise their index writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentflow-store-'));
  try {
    const first = createStore(root);
    const second = createStore(root);
    const ids = Array.from({ length: 8 }, (_, index) => `run_shared${index}`);
    await Promise.all(ids.map((runId, index) => (index % 2 ? first : second).record({ runId, template: 't', status: 'completed' })));

    const list = await createStore(root).list(100);
    assert.equal(list.length, 8);
    assert.deepEqual(new Set(list.map((entry) => entry.runId)), new Set(ids));
  } finally {
    await removeDir(root);
  }
});

test('an unreadable runs directory is an error, not an empty history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentflow-store-'));
  try {
    // runs is a file, so readdir fails with ENOTDIR: that is not "no history".
    await writeFile(join(root, 'runs'), 'not a directory', 'utf8');
    await writeFile(join(root, 'index.json'), '{broken', 'utf8');
    const store = createStore(root);

    await assert.rejects(store.list(10), (error) => error.code === 'INDEX_UNREADABLE');
    // record() must refuse too, instead of overwriting the damaged index with a
    // single entry and silently dropping the rest.
    await assert.rejects(
      store.record({ runId: 'run_x1', template: 't', status: 'completed' }),
      (error) => error.code === 'INDEX_UNREADABLE',
    );
    assert.ok((await readdir(root)).includes('index.json'), 'index.json is preserved for a later retry');
  } finally {
    await removeDir(root);
  }
});

test('a stale index lock is reclaimed instead of blocking every write', async () => {
  await withStore(async (store, root) => {
    const lockPath = join(root, 'index.json.lock');
    await writeFile(lockPath, 'dead-owner', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    await store.record({ runId: 'run_stale01', template: 't', status: 'completed' });
    const list = await store.list(10);
    assert.equal(list[0].runId, 'run_stale01');
    assert.ok(!(await readdir(root)).includes('index.json.lock'), 'lock is released after the write');
  });
});

test('a missing index still degrades to empty', async () => {
  await withStore(async (store) => {
    assert.deepEqual(await store.list(), []);
  });
});

