// Step 2: collect the data the recommender needs.
//  1. the target player's profile and top 200 scores
//  2. ranking pages around the player's rank (country or global)
//  3. the top 100 scores of the N players whose pp is closest to the player's
import { HOUR, DAY } from './cache.js';

export const RANKING_PAGE_SIZE = 50;
export const RANKING_MAX_PAGE = 200; // the osu! API serves rankings down to rank 10,000

const TTL = {
  user: 1 * HOUR,
  myBest: 10 * 60 * 1000, // your own scores change often, so keep them only briefly
  ranking: 1 * DAY,
  neighborBest: 3 * DAY,
};

// Reduce an API score object to the fields this tool uses (keeps the cache small).
export function compactScore(s) {
  const b = s.beatmap ?? {};
  const set = s.beatmapset ?? {};
  const mods = (s.mods ?? []).map((m) => (typeof m === 'string' ? m : m.acronym)).filter((m) => m && m !== 'CL');
  return {
    beatmapId: b.id,
    beatmapsetId: set.id ?? b.beatmapset_id,
    artist: set.artist ?? '',
    title: set.title ?? '',
    version: b.version ?? '',
    stars: b.difficulty_rating, // without mods
    length: b.total_length, // seconds, without mods
    bpm: b.bpm,
    mods,
    pp: s.pp ?? 0,
    accuracy: s.accuracy,
  };
}

export class CollectError extends Error {}

/**
 * @param {object} o
 * @param {import('./osu-api.js').OsuApi} o.api
 * @param {import('./cache.js').FileCache} o.cache
 * @param {string} o.username
 * @param {'country'|'global'} [o.scope]  compare with players from the same country, or worldwide
 * @param {number} [o.count]               how many nearby players to collect
 * @param {(p: object) => void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 */
export async function collect({ api, cache, username, scope = 'country', count = 250, onProgress = () => {}, signal }) {
  const check = () => {
    if (signal?.aborted) throw new CollectError('Cancelled.');
  };
  const report = (p) => onProgress({ ...p, at: Date.now() });

  // 1. Target player
  report({ phase: 'user', message: 'Looking up the player' });
  const { value: u } = await cache.wrap(`user-${username.toLowerCase()}`, TTL.user, () => api.getUser(username));
  const me = {
    id: u.id,
    username: u.username,
    country: u.country_code,
    pp: u.statistics?.pp ?? 0,
    globalRank: u.statistics?.global_rank ?? null,
    countryRank: u.statistics?.country_rank ?? null,
  };
  const rank = scope === 'global' ? me.globalRank : me.countryRank;
  if (!rank) throw new CollectError('This player has no rank yet, so there is no one to compare with.');
  if (rank > RANKING_MAX_PAGE * RANKING_PAGE_SIZE) {
    throw new CollectError(
      `The osu! API only lists the top ${RANKING_MAX_PAGE * RANKING_PAGE_SIZE} players, and this player is #${rank} ` +
        `${scope === 'global' ? 'worldwide' : 'in their country'}. Players outside that range are not supported yet.`,
    );
  }

  check();
  report({ phase: 'myBest', message: 'Fetching your top scores' });
  const myBest = [];
  for (const offset of [0, 100]) {
    const { value } = await cache.wrap(`best-me-${me.id}-${offset}`, TTL.myBest, async () =>
      (await api.getBestScores(me.id, { limit: 100, offset })).map(compactScore),
    );
    myBest.push(...value);
    if (value.length < 100) break;
  }

  // 2. Ranking pages around the player's rank. Take a few more players than needed,
  //    then keep the ones whose pp is closest.
  const pagesNeeded = Math.ceil((count * 1.2) / RANKING_PAGE_SIZE) + 1;
  const centerPage = Math.ceil(rank / RANKING_PAGE_SIZE);
  let first = Math.max(1, centerPage - Math.floor(pagesNeeded / 2));
  const last = Math.min(RANKING_MAX_PAGE, first + pagesNeeded - 1);
  first = Math.max(1, last - pagesNeeded + 1);

  const country = scope === 'global' ? undefined : me.country;
  const candidates = new Map();
  for (let page = first; page <= last; page++) {
    check();
    report({ phase: 'ranking', message: 'Reading the rankings', done: page - first, total: last - first + 1 });
    const { value } = await cache.wrap(`ranking-${country ?? 'global'}-${page}`, TTL.ranking, async () =>
      ((await api.getRanking({ country, page })).ranking ?? []).map((r) => ({ id: r.user.id, username: r.user.username, pp: r.pp })),
    );
    for (const r of value) if (r.id !== me.id) candidates.set(r.id, r);
  }

  const neighborsBase = [...candidates.values()]
    .sort((a, b) => Math.abs(a.pp - me.pp) - Math.abs(b.pp - me.pp))
    .slice(0, count);

  // 3. Top scores of each nearby player
  const neighbors = [];
  const startedAt = Date.now();
  let fetched = 0;
  for (let i = 0; i < neighborsBase.length; i++) {
    check();
    const n = neighborsBase[i];
    try {
      const { value, cached } = await cache.wrap(`best-${n.id}`, TTL.neighborBest, async () =>
        (await api.getBestScores(n.id, { limit: 100 })).map(compactScore),
      );
      if (!cached) fetched++;
      neighbors.push({ ...n, best: value });
    } catch (e) {
      if (e.status === 404) continue; // account deleted or restricted since the ranking was cached
      throw e;
    }
    const elapsed = Date.now() - startedAt;
    const perFetch = fetched ? elapsed / fetched : 1000;
    const remainingFetches = Math.round((neighborsBase.length - i - 1) * (fetched / (i + 1) || 1));
    report({
      phase: 'neighbors',
      message: 'Fetching top scores of nearby players',
      done: i + 1,
      total: neighborsBase.length,
      etaSec: Math.round((remainingFetches * perFetch) / 1000),
    });
  }

  report({ phase: 'done', message: 'Done', done: neighbors.length, total: neighbors.length });
  return {
    me,
    myBest,
    scope,
    neighbors,
    ppRange: neighbors.length ? [Math.min(...neighbors.map((n) => n.pp)), Math.max(...neighbors.map((n) => n.pp))] : null,
  };
}
