import { rm } from 'node:fs/promises';

/**
 * Windows can report ENOTEMPTY/EPERM while a just-closed write handle is still
 * being released, which makes a one-shot `rm -rf` flaky in tests. Retry briefly.
 */
export async function removeDir(path, attempts = 6) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 2 });
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error;
      await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
    }
  }
  throw lastError;
}
