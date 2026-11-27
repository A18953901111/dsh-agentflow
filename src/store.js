/**
 * Run artifact store: `<root>/runs/<runId>/{run.json, trace.jsonl, result.md}`
 * plus a trimmed `<root>/index.json`.
 *
 * Artifacts are the product of a run, not a cache: they must survive restarts
 * and stay readable by a human, so writes are plain JSON/Markdown and every
 * file is replaced atomically (write-then-rename). The index is derived data:
 * it may be rebuilt from `runs/<id>/run.json` at any time, and a damaged index
 * must never take history with it.
 */
import { mkdir, open, readFile, readdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const INDEX_LIMIT = 50;
const LOCK_RETRY_MS = 20;
const LOCK_RETRIES = 100;
const LOCK_STALE_MS = 10_000;
// Refresh well inside the stale window so a slow-but-alive holder is never
// mistaken for a crashed one.
const LOCK_HEARTBEAT_MS = 2_000;

// One chain per index file, shared by every store instance in this process: a
// second createStore() on the same root (a reload, a second AgentFlow) must not
// interleave read-modify-write on the same index.json.
const indexChains = new Map();

function enqueue(indexPath, task) {
  const previous = indexChains.get(indexPath) ?? Promise.resolve();
  const next = previous.then(task);
  indexChains.set(indexPath, next.catch(() => {}));
  return next;
}

export function newRunId() {
  return `run_${randomBytes(4).toString('hex')}`;
}

export function createStore(root) {
  const runsDir = join(root, 'runs');
  const indexPath = join(root, 'index.json');
  const lockPath = `${indexPath}.lock`;

  async function ensure() {
    await mkdir(runsDir, { recursive: true });
  }

  async function writeAtomic(path, text) {
    const tmp = `${path}.${randomBytes(3).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, path);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }

  // Cross-process mutual exclusion. The promise chain above only serializes
  // callers inside this process; two harness processes can share a root.
  //
  // The lock file carries an owner token. Reclaiming a stale lock renames it
  // aside first, which only one process can win, so a lock that another process
  // just re-created is never unlinked by a third party (the earlier
  // stat-then-unlink version had exactly that race).
  async function releaseIndexLock(token) {
    try {
      const current = await readFile(lockPath, 'utf8');
      if (current.trim() === token) await unlink(lockPath).catch(() => {});
    } catch {
      // Nothing to release: the lock is gone or unreadable.
    }
  }

  async function withIndexLock(fn) {
    const token = randomBytes(8).toString('hex');
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
      let handle = null;
      try {
        handle = await open(lockPath, 'wx');
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        // A crashed writer leaves its lock behind; reclaim it once it is old.
        try {
          const info = await stat(lockPath);
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
            const tomb = `${lockPath}.stale-${token}`;
            try {
              await rename(lockPath, tomb);
              await unlink(tomb).catch(() => {});
            } catch {
              // Someone else reclaimed it first; just retry.
            }
            continue;
          }
        } catch {
          // The lock disappeared between open and stat: retry immediately.
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
        continue;
      }

      // The heartbeat must refresh the inode we hold, not whatever currently
      // sits at lockPath: refreshing by path would keep a stolen lock alive and
      // let this process believe it still owns the critical section.
      const heartbeat = setInterval(() => {
        const now = new Date();
        handle.utimes(now, now).catch(() => {});
      }, LOCK_HEARTBEAT_MS);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();

      // Ownership check for the caller to run right before it writes.
      const assertOwner = async () => {
        let current = '';
        try {
          current = (await readFile(lockPath, 'utf8')).trim();
        } catch {
          current = '';
        }
        if (current !== token) {
          throw Object.assign(new Error('index lock was stolen; refusing to write'), { code: 'LOCK_LOST' });
        }
      };

      try {
        await handle.writeFile(token, 'utf8');
        await assertOwner();
        return await fn(assertOwner);
      } catch (error) {
        if (error?.code === 'LOCK_LOST') {
          // Retry the whole acquisition instead of writing under a stale belief.
          continue;
        }
        throw error;
      } finally {
        clearInterval(heartbeat);
        await releaseIndexLock(token);
        await handle.close().catch(() => {});
      }
    }
    throw new Error(`could not acquire ${lockPath} within ${LOCK_RETRIES * LOCK_RETRY_MS}ms`);
  }

  function indexEntry(record, runId) {
    return {
      runId,
      template: record.template,
      status: record.status,
      startedAt: record.startedAt,
      durationMs: record.durationMs,
      agentsStarted: record.agentsStarted,
      anchorCoverage: record.anchors?.coverage ?? null,
      dir: join(runsDir, runId),
    };
  }

  /**
   * Rebuild the index from the run.json files, which are the real artifacts.
   * The unreadable index is kept aside instead of being overwritten, so a bad
   * parse is diagnosable rather than silently destructive.
   *
   * The damaged index is only moved aside once the rebuild is actually
   * possible: a transient readdir failure must not cost the history (the old
   * version renamed first and returned an empty index when readdir failed).
   */
  async function rebuildIndex(assertOwner) {
    const entries = [];
    let names;
    try {
      names = await readdir(runsDir);
    } catch (error) {
      // A missing runs/ directory really means "no history yet". Any other
      // failure must surface: returning an empty index here would let the next
      // record() overwrite the real index with a single entry.
      if (error?.code === 'ENOENT') return { runs: [] };
      throw Object.assign(new Error(`index rebuild failed: ${error?.message ?? error}`), { code: 'INDEX_UNREADABLE' });
    }
    for (const name of names) {
      try {
        const record = JSON.parse(await readFile(join(runsDir, name, 'run.json'), 'utf8'));
        entries.push(indexEntry(record, name));
      } catch {
        // Directories without a readable run.json are not history; skip them.
      }
    }
    entries.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
    const rebuilt = { runs: entries.slice(0, INDEX_LIMIT) };
    if (assertOwner) await assertOwner();
    // Only now move the damaged file aside, and put it back if the write fails.
    const backup = `${indexPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const moved = await rename(indexPath, backup).then(() => true).catch(() => false);
    await ensure();
    try {
      if (assertOwner) await assertOwner();
      await writeAtomic(indexPath, `${JSON.stringify(rebuilt, null, 2)}\n`);
    } catch (error) {
      if (moved) await rename(backup, indexPath).catch(() => {});
      throw error;
    }
    return rebuilt;
  }

  async function readIndex(assertOwner) {
    let text;
    try {
      text = await readFile(indexPath, 'utf8');
    } catch (error) {
      // Only "no index yet" means empty; a transient read failure must not.
      if (error?.code === 'ENOENT') return { runs: [] };
      return rebuildIndex(assertOwner);
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed && Array.isArray(parsed.runs)) return parsed;
      throw new Error('index.json has no runs array');
    } catch {
      return rebuildIndex(assertOwner);
    }
  }

  return {
    root,
    runsDir,
    indexPath,
    dirOf(runId) {
      return join(runsDir, runId);
    },
    async ensure() {
      await ensure();
    },
    async writeRun(runId, record) {
      await ensure();
      const dir = join(runsDir, runId);
      await mkdir(dir, { recursive: true });
      await writeAtomic(join(dir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
      return join(dir, 'run.json');
    },
    async writeText(runId, fileName, text) {
      await ensure();
      const dir = join(runsDir, runId);
      await mkdir(dir, { recursive: true });
      await writeAtomic(join(dir, fileName), text);
      return join(dir, fileName);
    },
    async record(entry) {
      return enqueue(indexPath, () => withIndexLock(async (assertOwner) => {
        const index = await readIndex(assertOwner);
        index.runs = [entry, ...index.runs.filter((run) => run.runId !== entry.runId)].slice(0, INDEX_LIMIT);
        await ensure();
        await assertOwner();
        await writeAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`);
        return entry;
      }));
    },
    async list(limit = 10) {
      // Reads go through the same queue and lock: a rebuild triggered here
      // rewrites index.json, and an unlocked one could overwrite an entry a
      // concurrent record() had just written.
      const index = await enqueue(indexPath, () => withIndexLock((assertOwner) => readIndex(assertOwner)));
      return index.runs.slice(0, limit);
    },
    async read(runId) {
      try {
        return JSON.parse(await readFile(join(runsDir, runId, 'run.json'), 'utf8'));
      } catch {
        return null;
      }
    },
  };
}
