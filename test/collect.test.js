import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { FileCache } from '../src/cache.js';
import { collect, compactScore } from '../src/collect.js';

// Fake osu! world: 10,000 players in JP, pp decreasing by 1 per rank from 13,000.
function fakeApi({ meRank = 9835 } = {}) {
  const calls = { ranking: [], best: [] };
  const ppAt = (rank) => 13000 - rank;
  const score = (bid, pp) => ({
    pp, accuracy: 0.98, mods: [{ acronym: 'CL' }, { acronym: 'DT' }],
    beatmap: { id: bid, version: 'Insane', difficulty_rating: 4.5, total_length: 90, bpm: 180 },
    beatmapset: { id: bid * 10, artist: 'A', title: 'T' + bid },
  });
  return {
    calls,
    getUser: async () => ({ id: 1, username: 'me', country_code: 'JP', statistics: { pp: ppAt(meRank), global_rank: 270000, country_rank: meRank } }),
    getBestScores: async (id, { offset = 0 } = {}) => {
      calls.best.push([id, offset]);
      if (id === 404404) { const e = new Error('Not found.'); e.status = 404; throw e; }
      const n = id === 1 && offset === 100 ? 50 : 100;
      return Array.from({ length: n }, (_, i) => score(id * 1000 + i + offset, 150 - i));
    },
    getRanking: async ({ country, page }) => {
      calls.ranking.push([country, page]);
      return { ranking: Array.from({ length: 50 }, (_, i) => {
        const rank = (page - 1) * 50 + i + 1;
        const id = rank === meRank ? 1 : rank === meRank + 1 ? 404404 : 100000 + rank;
        return { pp: ppAt(rank), user: { id, username: 'u' + rank } };
      }) };
    },
  };
}
const tmpCache = () => new FileCache(mkdtempSync(path.join(os.tmpdir(), 'off-')));

test('compactScore drops CL and keeps needed fields', () => {
  const s = compactScore({ pp: 100, accuracy: 0.99, mods: [{ acronym: 'CL' }, { acronym: 'HD' }], beatmap: { id: 5, version: 'X', difficulty_rating: 5, total_length: 60, bpm: 200 }, beatmapset: { id: 6, artist: 'a', title: 't' } });
  assert.deepEqual(s.mods, ['HD']);
  assert.equal(s.beatmapId, 5); assert.equal(s.beatmapsetId, 6);
});

test('collects nearest players around the rank, skips self and missing users', async () => {
  const api = fakeApi();
  const progress = [];
  const r = await collect({ api, cache: tmpCache(), username: 'me', count: 100, onProgress: (p) => progress.push(p.phase) });
  assert.equal(r.me.id, 1);
  assert.equal(r.myBest.length, 150); // 100 + 50
  assert.equal(r.neighbors.length, 99); // 100 nearest minus the 404 one
  assert.ok(!r.neighbors.some((n) => n.id === 1));
  const ranks = r.neighbors.map((n) => 13000 - n.pp);
  assert.ok(Math.max(...ranks.map((x) => Math.abs(x - 9835))) <= 51, 'neighbors should be close in rank');
  assert.ok(api.calls.ranking.every(([c, p]) => c === 'JP' && p >= 1 && p <= 200));
  assert.ok(progress.includes('neighbors') && progress.at(-1) === 'done');
});

test('second run uses the cache', async () => {
  const cache = tmpCache();
  const api1 = fakeApi();
  await collect({ api: api1, cache, username: 'me', count: 60 });
  const api2 = fakeApi();
  await collect({ api: api2, cache, username: 'me', count: 60 });
  assert.equal(api2.calls.ranking.length, 0);
  const neighborFetches = api2.calls.best.filter(([id]) => id !== 1);
  assert.equal(neighborFetches.length, 1, 'only the 404 user is retried');
});

test('pages are clamped near the top of the ranking', async () => {
  const api = fakeApi({ meRank: 30 });
  await collect({ api, cache: tmpCache(), username: 'me', count: 100 });
  assert.ok(api.calls.ranking.every(([, p]) => p >= 1));
  assert.equal(api.calls.ranking[0][1], 1);
});

test('rejects players outside the top 10,000', async () => {
  const api = fakeApi();
  api.getUser = async () => ({ id: 1, username: 'me', country_code: 'JP', statistics: { pp: 100, global_rank: 900000, country_rank: 20000 } });
  await assert.rejects(collect({ api, cache: tmpCache(), username: 'me' }), /top 10000/);
});

test('global scope omits the country filter', async () => {
  const api = fakeApi();
  api.getUser = async () => ({ id: 1, username: 'me', country_code: 'JP', statistics: { pp: 5000, global_rank: 8000, country_rank: 300 } });
  await collect({ api, cache: tmpCache(), username: 'me', scope: 'global', count: 50 });
  assert.ok(api.calls.ranking.every(([c, p]) => c === undefined && p >= 155 && p <= 165));
});

test('can be cancelled', async () => {
  const ac = new AbortController();
  const api = fakeApi();
  const orig = api.getBestScores;
  api.getBestScores = async (...a) => { if (a[0] !== 1) ac.abort(); return orig(...a); };
  await assert.rejects(collect({ api, cache: tmpCache(), username: 'me', count: 100, signal: ac.signal }), /Cancelled/);
});
