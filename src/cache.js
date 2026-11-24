// Simple file cache for API responses, stored under ~/.osu-farm-finder/cache/.
// Each entry is a JSON file holding { savedAt, value }. Entries older than their TTL are ignored.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export class FileCache {
  constructor(dir = path.join(DATA_DIR, 'cache')) {
    this.dir = dir;
  }

  #file(key) {
    return path.join(this.dir, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  }

  async get(key, ttlMs) {
    try {
      const { savedAt, value } = JSON.parse(await fs.readFile(this.#file(key), 'utf8'));
      if (Date.now() - savedAt <= ttlMs) return value;
    } catch {
      /* missing or broken entry: treat as a miss */
    }
    return undefined;
  }

  async set(key, value) {
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.#file(key);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ savedAt: Date.now(), value }));
    await fs.rename(tmp, file); // atomic replace so a crash never leaves half a file
  }

  // Returns the cached value if fresh; otherwise calls load(), stores and returns its result.
  async wrap(key, ttlMs, load) {
    const hit = await this.get(key, ttlMs);
    if (hit !== undefined) return { value: hit, cached: true };
    const value = await load();
    await this.set(key, value);
    return { value, cached: false };
  }

  async clear() {
    await fs.rm(this.dir, { recursive: true, force: true });
  }

  async stats() {
    try {
      const names = (await fs.readdir(this.dir)).filter((n) => n.endsWith('.json'));
      let bytes = 0;
      for (const n of names) bytes += (await fs.stat(path.join(this.dir, n))).size;
      return { entries: names.length, bytes };
    } catch {
      return { entries: 0, bytes: 0 };
    }
  }
}

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
