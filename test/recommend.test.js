import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommend, speedOf, weightedPp, totalPpGain } from '../src/recommend.js';

const sc = (beatmapId, pp, mods = [], extra = {}) => ({
  beatmapId, beatmapsetId: extra.set ?? beatmapId * 10, artist: 'A', title: 'T' + beatmapId,
  version: 'v', stars: extra.stars ?? 5, length: extra.length ?? 90, bpm: 180, mods, pp,
});

// Me: maps 1..10. Similar players (s1..s5) share maps 1..5 and all have map 100 (NM) and 200 (DT).
// Dissimilar players (d1..d5) share nothing and all have map 300.
function data() {
  const myBest = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((b, i) => sc(b, 150 - i * 5));
  myBest.push(sc(400, 90)); // I have map 400 but weakly
  myBest.push(sc(500, 128)); // I have map 500 almost as well as others
  const similar = Array.from({ length: 5 }, (_, i) => ({
    id: 10 + i, username: 's' + i, pp: 3200,
    best: [1, 2, 3, 4, 5].map((b) => sc(b, 140)).concat([
      sc(100, 130 + i), sc(200, 120, ['DT', 'HD']), sc(200, 110), sc(400, 140), sc(500, 130),
      sc(600, 125, [], { set: 10 }), // another difficulty of my map 1's song
      sc(700, 150, [], { stars: 6.5, length: 300 }),
    ]),
  }));
  const dissimilar = Array.from({ length: 5 }, (_, i) => ({
    id: 20 + i, username: 'd' + i, pp: 3200, best: [sc(300, 160), sc(301, 100)],
  }));
  return { me: { id: 1, username: 'me' }, scope: 'country', myBest, neighbors: [...similar, ...dissimilar] };
}

test('speedOf groups speed mods', () => {
  assert.equal(speedOf(['DT', 'HD']), 'DT');
  assert.equal(speedOf(['NC']), 'DT');
  assert.equal(speedOf(['HT']), 'HT');
  assert.equal(speedOf(['HD', 'HR']), 'NM');
});

test('recommends maps popular among similar players only', () => {
  const r = recommend(data(), { minPlayers: 3 });
  const keys = r.rows.map((x) => `${x.beatmapId}:${x.speed}`);
  assert.ok(keys.includes('100:NM'));
  assert.ok(!keys.some((k) => k.startsWith('300:')), 'dissimilar players are not used');
  assert.equal(r.usedPlayers, 5, 'players with zero similarity are dropped');
  assert.equal(r.similarPlayers[0].similarity, 7.3); // maps 1-5, 400, 500 = 7; map 600 (same song as 1) = 0.3
});

test('NM and DT are counted separately', () => {
  const r = recommend(data(), { minPlayers: 3 });
  const dt = r.rows.find((x) => x.beatmapId === 200 && x.speed === 'DT');
  const nm = r.rows.find((x) => x.beatmapId === 200 && x.speed === 'NM');
  assert.equal(dt.medianPp, 120);
  assert.equal(nm.medianPp, 110);
  assert.deepEqual(dt.mods, [{ mods: 'DTHD', count: 5 }]);
});

test('keeps maps I have only if I am clearly behind', () => {
  const r = recommend(data(), { minPlayers: 3 });
  const m400 = r.rows.find((x) => x.beatmapId === 400);
  assert.equal(m400.myPp, 90);
  assert.ok(!r.rows.some((x) => x.beatmapId === 500), '128 vs 130 is already farmed');
  assert.ok(!r.rows.some((x) => x.beatmapId <= 10));
});

test('flags another difficulty of a song I already have', () => {
  const r = recommend(data(), { minPlayers: 3 });
  assert.equal(r.rows.find((x) => x.beatmapId === 600).sameSongInMyBest, true);
  assert.equal(r.rows.find((x) => x.beatmapId === 100).sameSongInMyBest, false);
});

test('filters by stars, length and speed', () => {
  const d = data();
  assert.ok(!recommend(d, { minPlayers: 3, maxStars: 6 }).rows.some((x) => x.beatmapId === 700));
  assert.ok(!recommend(d, { minPlayers: 3, maxLength: 120 }).rows.some((x) => x.beatmapId === 700));
  assert.ok(recommend(d, { minPlayers: 3, speed: 'DT' }).rows.every((x) => x.speed === 'DT'));
  assert.equal(recommend(d, { minPlayers: 6 }).rows.length, 0);
});

test('rankIfAdded places the median pp in my top scores', () => {
  const r = recommend(data(), { minPlayers: 3 });
  const m700 = r.rows.find((x) => x.beatmapId === 700); // 150pp; my #1 is 150 -> lands at #2
  assert.equal(m700.rankIfAdded, 2);
  assert.equal(r.myTop1Pp, 150);
});

test('weightedPp follows the osu! 0.95 weighting', () => {
  assert.equal(weightedPp([100, 200]), 200 + 100 * 0.95);
  assert.equal(weightedPp([]), 0);
});

test('totalPpGain inserts new maps and replaces better scores on the same map', () => {
  const gain = totalPpGain([sc(1, 200), sc(2, 100), sc(2, 80, ['DT'])]);
  const base = 200 + 100 * 0.95;
  // New map at 150pp: 200, 150, 100
  assert.ok(Math.abs(gain(3, 150) - (200 + 150 * 0.95 + 100 * 0.95 ** 2 - base)) < 1e-9);
  // Map 2 improved from 100 to 150: 200, 150 (the old 100 is replaced; the 80 DT score never counted)
  assert.ok(Math.abs(gain(2, 150) - (200 + 150 * 0.95 - base)) < 1e-9);
  // A worse score on a map I have changes nothing
  assert.equal(gain(2, 90), 0);
});

test('rows carry ppGain, and new maps gain more than retakes of the same pp', () => {
  const r = recommend(data(), { minPlayers: 3 });
  const m100 = r.rows.find((x) => x.beatmapId === 100);
  const m400 = r.rows.find((x) => x.beatmapId === 400); // I already have 90pp there
  assert.ok(m100.ppGain > 0);
  assert.ok(m400.ppGain > 0);
  const fresh = totalPpGain(data().myBest)(999, m400.medianPp);
  assert.ok(m400.ppGain < fresh, 'replacing my 90pp score gains less than a brand-new map');
});
