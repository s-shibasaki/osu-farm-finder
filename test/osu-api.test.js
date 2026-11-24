import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OsuApi } from '../src/osu-api.js';

function fakeFetch(handlers) {
  const calls = [];
  const f = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname + u.search, opts, at: Date.now() });
    const h = handlers.shift();
    return h(u, opts);
  };
  f.calls = calls;
  return f;
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const tokenOk = () => json(200, { access_token: 'T', expires_in: 86400 });

test('fetches token once and sends bearer header', async () => {
  const f = fakeFetch([tokenOk, () => json(200, { id: 1, username: 'a' }), () => json(200, { id: 2 })]);
  const api = new OsuApi({ clientId: '1', clientSecret: 's', minIntervalMs: 0, fetchImpl: f });
  await api.getUser('shiba_em');
  await api.getUser(2475220);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[1].path, '/api/v2/users/%40shiba_em/osu');
  assert.equal(f.calls[2].path, '/api/v2/users/2475220/osu');
  assert.equal(f.calls[1].opts.headers.Authorization, 'Bearer T');
});

test('retries on 429 using retry-after', async () => {
  const f = fakeFetch([tokenOk, () => json(429, {}, { 'retry-after': '0' }), () => json(200, [])]);
  const api = new OsuApi({ clientId: '1', clientSecret: 's', minIntervalMs: 0, fetchImpl: f });
  assert.deepEqual(await api.getBestScores(1), []);
  assert.equal(f.calls.length, 3);
});

test('readable error on bad credentials', async () => {
  const f = fakeFetch([() => json(401, {})]);
  const api = new OsuApi({ clientId: '1', clientSecret: 'bad', minIntervalMs: 0, fetchImpl: f });
  await assert.rejects(api.getUser('x'), /client ID or secret/);
});

test('spaces requests by minIntervalMs', async () => {
  const f = fakeFetch([tokenOk, () => json(200, {}), () => json(200, {}), () => json(200, {})]);
  const api = new OsuApi({ clientId: '1', clientSecret: 's', minIntervalMs: 150, fetchImpl: f });
  await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')]);
  const t = f.calls.slice(1).map((c) => c.at);
  assert.ok(t[1] - t[0] >= 140 && t[2] - t[1] >= 140, `gaps: ${t[1]-t[0]}, ${t[2]-t[1]}`);
});

test('ranking uses cursor[page]', async () => {
  const f = fakeFetch([tokenOk, () => json(200, { ranking: [] })]);
  const api = new OsuApi({ clientId: '1', clientSecret: 's', minIntervalMs: 0, fetchImpl: f });
  await api.getRanking({ country: 'JP', page: 197 });
  assert.equal(decodeURIComponent(f.calls[1].path), '/api/v2/rankings/osu/performance?country=JP&cursor[page]=197');
});
