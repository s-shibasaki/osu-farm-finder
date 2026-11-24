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

export class CollectError extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

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
    if (signal?.aborted) throw new CollectError('Cancelled.', 'CANCELLED');
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
  if (!rank || !me.pp) throw new CollectError('This player has no rank yet, so there is no one to compare with.', 'NO_RANK');
  // Outside the top 10,000 of the chosen ranking: gather players from other countries' rankings instead,
  // because in countries with fewer players, low-pp players are still within the top 10,000.
  const outOfRange = rank > RANKING_MAX_PAGE * RANKING_PAGE_SIZE;

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

  // 2. Find players with pp close to the target.
  let neighborsBase;
  let countriesUsed = null;
  if (!outOfRange) {
    neighborsBase = await nearFromOwnRanking({ api, cache, me, rank, scope, count, report, check });
  } else {
    ({ neighborsBase, countriesUsed } = await nearFromOtherCountries({ api, cache, me, count, report, check }));
    if (neighborsBase.length < Math.min(20, count)) {
      throw new CollectError(
        `Could not find enough players with pp close to ${Math.round(me.pp)} in any country's top ${RANKING_MAX_PAGE * RANKING_PAGE_SIZE}.`,
        'NOT_ENOUGH_PLAYERS',
        { found: neighborsBase.length },
      );
    }
  }

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
    scope: outOfRange ? 'countries' : scope,
    countriesUsed,
    neighbors,
    ppRange: neighbors.length ? [Math.min(...neighbors.map((n) => n.pp)), Math.max(...neighbors.map((n) => n.pp))] : null,
  };
}

const cachedRanking = (api, cache, country, page) =>
  cache
    .wrap(`ranking-${country ?? 'global'}-${page}`, TTL.ranking, async () =>
      ((await api.getRanking({ country, page })).ranking ?? []).map((r) => ({ id: r.user.id, username: r.user.username, pp: r.pp, country: r.user.country_code ?? country })),
    )
    .then((r) => r.value);

// The usual case: read the ranking pages around the player's own rank.
async function nearFromOwnRanking({ api, cache, me, rank, scope, count, report, check }) {
  // Take a few more players than needed, then keep the ones whose pp is closest.
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
    for (const r of await cachedRanking(api, cache, country, page)) if (r.id !== me.id) candidates.set(r.id, r);
  }
  return [...candidates.values()].sort((a, b) => Math.abs(a.pp - me.pp) - Math.abs(b.pp - me.pp)).slice(0, count);
}

export const NEAR_WINDOW = 0.15; // players within ±15% pp count as "close" when searching other countries

// Fallback for players outside the top 10,000: in each country whose top 10,000 reaches the
// player's pp, binary-search the ranking page with that pp and take the closest players.
// At most a fifth of the players come from any one country, so no single country dominates.
async function nearFromOtherCountries({ api, cache, me, count, report, check }) {
  const lo = me.pp * (1 - NEAR_WINDOW);
  const hi = me.pp * (1 + NEAR_WINDOW);
  const perCountry = Math.max(10, Math.ceil(count / 5));

  const countries = [];
  for (let page = 1; page <= 3; page++) {
    const { value } = await cache.wrap(`country-ranking-${page}`, TTL.ranking, async () =>
      ((await api.getCountryRanking({ page })).ranking ?? []).map((c) => ({ code: c.code ?? c.country?.code, active: c.active_users ?? 0 })),
    );
    countries.push(...value);
  }
  countries.sort((a, b) => b.active - a.active); // bigger countries first: more players near the pp

  const picked = new Map();
  const leftovers = []; // close players not taken because of the per-country cap
  const used = new Map();
  for (let i = 0; i < countries.length && picked.size < count; i++) {
    check();
    const c = countries[i].code;
    report({ phase: 'ranking', message: 'Searching other countries', done: picked.size, total: count, country: c });
    const page = (p) => cachedRanking(api, cache, c, p);
    const lastPage = await page(RANKING_MAX_PAGE);
    if (lastPage.length && lastPage.at(-1).pp > hi) continue; // this country's top 10,000 ends above the range

    // First page whose lowest pp is at or below the player's pp.
    let a = 1;
    let b = RANKING_MAX_PAGE;
    while (a < b) {
      const m = (a + b) >> 1;
      const rows = await page(m);
      if (rows.length && rows.at(-1).pp > me.pp) a = m + 1;
      else b = m;
    }
    const near = [];
    for (let p = Math.max(1, a - 2); p <= Math.min(RANKING_MAX_PAGE, a + 2); p++) {
      for (const r of await page(p)) if (r.pp >= lo && r.pp <= hi && r.id !== me.id && !picked.has(r.id)) near.push({ ...r, country: r.country ?? c });
    }
    near.sort((x, y) => Math.abs(x.pp - me.pp) - Math.abs(y.pp - me.pp));
    const n = Math.min(perCountry, count - picked.size);
    for (const r of near.slice(0, n)) picked.set(r.id, r);
    leftovers.push(...near.slice(n));
    if (n > 0 && near.length) used.set(c, Math.min(n, near.length));
  }
  // Not enough countries reach this pp: fill up from the leftovers, closest pp first.
  leftovers.sort((x, y) => Math.abs(x.pp - me.pp) - Math.abs(y.pp - me.pp));
  for (const r of leftovers) {
    if (picked.size >= count) break;
    if (picked.has(r.id)) continue;
    picked.set(r.id, r);
    used.set(r.country, (used.get(r.country) ?? 0) + 1);
  }
  const countriesUsed = [...used.entries()].map(([code, players]) => ({ code, players })).sort((a, b) => b.players - a.players);
  return { neighborsBase: [...picked.values()], countriesUsed };
}
