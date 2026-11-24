import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

process.env.OSU_FARM_FINDER_HOME = mkdtempSync(path.join(os.tmpdir(), 'off-srv-'));
process.env.OSU_FARM_FINDER_MIN_INTERVAL_MS = '1';

// Fake osu! server behind global fetch; requests to our own local server pass through.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = new URL(url);
  if (u.hostname !== 'osu.ppy.sh') return realFetch(url, opts);
  const j = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
  if (u.pathname === '/oauth/token') {
    return String(opts.body).includes('client_secret=good') ? j({ access_token: 'T', expires_in: 86400 }) : j({}, 401);
  }
  if (u.pathname.startsWith('/api/v2/users/') && u.pathname.endsWith('/osu')) {
    return j({ id: 1, username: 'shiba_em', country_code: 'JP', statistics: { pp: 3245, global_rank: 272000, country_rank: 9835 } });
  }
  if (u.pathname.endsWith('/scores/best')) {
    return j(Array.from({ length: 100 }, (_, i) => ({ pp: 150 - i, mods: [], beatmap: { id: i, version: 'v' }, beatmapset: { id: i } })));
  }
  if (u.pathname === '/api/v2/rankings/osu/performance') {
    const page = Number(u.searchParams.get('cursor[page]'));
    return j({ ranking: Array.from({ length: 50 }, (_, i) => ({ pp: 4000 - ((page - 1) * 50 + i), user: { id: 1000 + (page - 1) * 50 + i, username: 'x' } })) });
  }
  return j({}, 404);
};

const { createServer } = await import('../src/server.js');
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, body) => {
  const r = await realFetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};

test('config: bad secret rejected, good secret saved and never returned', async () => {
  assert.equal((await call('POST', '/api/config', { clientId: '123', clientSecret: 'bad' })).status, 401);
  assert.equal((await call('POST', '/api/config', { clientId: '123', clientSecret: 'good' })).status, 200);
  const cfg = await call('GET', '/api/config');
  assert.deepEqual(cfg.json, { configured: true, clientId: '123' });
});

test('job runs to completion and reports a summary', async () => {
  const start = await call('POST', '/api/jobs', { username: 'shiba_em', count: 30 });
  assert.equal(start.status, 202);
  assert.equal((await call('POST', '/api/jobs', { username: 'shiba_em', count: 30 })).status, 409, 'one job at a time');
  let job;
  for (let i = 0; i < 100; i++) {
    job = (await call('GET', `/api/jobs/${start.json.id}`)).json;
    if (job.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.summary.neighbors, 30);
  assert.equal(job.summary.me.username, 'shiba_em');
  const c = await call('GET', '/api/cache');
  assert.ok(c.json.entries > 30);
});

test('validation and cache clear', async () => {
  assert.equal((await call('POST', '/api/jobs', { username: 'a', count: 5 })).status, 400);
  assert.equal((await call('GET', '/api/jobs/00000000-0000-0000-0000-000000000000')).status, 404);
  await call('DELETE', '/api/cache');
  assert.equal((await call('GET', '/api/cache')).json.entries, 0);
  server.close();
});
