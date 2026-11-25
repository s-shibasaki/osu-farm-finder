// Step 3: turn collected data into recommendations.
//
// 1. Similarity: for each nearby player, count how many of their top scores are on
//    maps that are also in your top scores (same difficulty = 1 point, another
//    difficulty of the same song = 0.3 points).
// 2. Keep the most similar players.
// 3. For every map in their top scores, count how many of them have it, and
//    collect the pp they got. Maps are counted separately for normal speed,
//    DT/NC (1.5x) and HT (0.75x), because speed changes pp a lot.
// 4. Drop maps you already have unless your pp there is clearly lower than theirs.
// 5. Estimate how much your total pp would rise if you matched their median pp.

export const DEFAULTS = {
  similarPlayers: 60, // how many of the most similar players to use
  sameSetWeight: 0.3, // similarity points for another difficulty of the same song
  minPlayers: 4, // a map must be in at least this many similar players' top scores
  improveRatio: 0.85, // keep a map you already have if your pp < their median × this
  limit: 100, // max rows to return
};

export function speedOf(mods) {
  if (mods.includes('DT') || mods.includes('NC')) return 'DT';
  if (mods.includes('HT') || mods.includes('DC')) return 'HT';
  return 'NM';
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// osu! total pp = sum of your top scores, sorted from highest pp, where the n-th score
// counts for pp × 0.95^(n-1). (The small bonus for the number of maps played does not
// change when one score is added, so it is left out.)
export const WEIGHT = 0.95;
const MAX_COUNTED = 200; // we fetch at most 200 of your top scores

export function weightedPp(pps) {
  const s = [...pps].sort((a, b) => b - a).slice(0, MAX_COUNTED);
  let total = 0;
  let w = 1;
  for (const pp of s) {
    total += pp * w;
    w *= WEIGHT;
  }
  return total;
}

/**
 * Returns gain(beatmapId, pp): how much your weighted total pp would rise if you set a
 * score worth `pp` on that map. osu! keeps only your best score per map (whatever the
 * mods), so a better score replaces the old one, and a worse one changes nothing.
 */
export function totalPpGain(myBest) {
  const bestPerMap = new Map();
  for (const s of myBest) bestPerMap.set(s.beatmapId, Math.max(bestPerMap.get(s.beatmapId) ?? 0, s.pp));
  const pps = [...bestPerMap.values()].sort((a, b) => b - a);
  const base = weightedPp(pps);
  return (beatmapId, pp) => {
    const old = bestPerMap.get(beatmapId);
    if (old != null && pp <= old) return 0;
    const next = [...pps, pp];
    if (old != null) next.splice(pps.indexOf(old), 1); // the new score replaces the old one
    return Math.max(0, weightedPp(next) - base);
  };
}

/**
 * @param {object} data  result of collect()
 * @param {object} [opts]
 * @param {number} [opts.minStars] @param {number} [opts.maxStars]  base (no-mod) star rating
 * @param {number} [opts.maxLength]  seconds, at normal speed
 * @param {'all'|'NM'|'DT'|'HT'} [opts.speed]
 */
export function recommend(data, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { myBest, neighbors } = data;

  // Your best pp per (map, speed), and the set of songs you have.
  const mine = new Map();
  const myMaps = new Set();
  const mySets = new Set();
  for (const s of myBest) {
    myMaps.add(s.beatmapId);
    mySets.add(s.beatmapsetId);
    const key = `${s.beatmapId}:${speedOf(s.mods)}`;
    mine.set(key, Math.max(mine.get(key) ?? 0, s.pp));
  }
  const myBestPpAt = (rank) => myBest.map((s) => s.pp).sort((a, b) => b - a)[rank - 1] ?? 0;

  // 1–2. Similarity
  const scored = neighbors.map((n) => {
    let sim = 0;
    for (const s of n.best) {
      if (myMaps.has(s.beatmapId)) sim += 1;
      else if (mySets.has(s.beatmapsetId)) sim += o.sameSetWeight;
    }
    return { ...n, similarity: Math.round(sim * 10) / 10 };
  });
  scored.sort((a, b) => b.similarity - a.similarity);
  const similar = scored.slice(0, Math.min(o.similarPlayers, scored.length)).filter((n) => n.similarity > 0);

  // 3. Aggregate maps
  const groups = new Map();
  for (const n of similar) {
    const seen = new Set(); // count each player once per (map, speed)
    for (const s of n.best) {
      const speed = speedOf(s.mods);
      const key = `${s.beatmapId}:${speed}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let g = groups.get(key);
      if (!g) {
        g = { key, speed, map: s, players: 0, weight: 0, pps: [], mods: new Map() };
        groups.set(key, g);
      }
      g.players++;
      g.weight += n.similarity;
      g.pps.push(s.pp);
      const label = s.mods.length ? s.mods.join('') : 'NM';
      g.mods.set(label, (g.mods.get(label) ?? 0) + 1);
    }
  }

  // 4. Filter and rank
  const myPps = myBest.map((s) => s.pp).sort((a, b) => b - a);
  const rankIfAdded = (pp) => {
    const i = myPps.findIndex((x) => pp > x);
    return i === -1 ? myPps.length + 1 : i + 1;
  };

  const gainFor = totalPpGain(myBest);

  const rows = [];
  for (const g of groups.values()) {
    if (g.players < o.minPlayers) continue;
    const m = g.map;
    if (o.speed && o.speed !== 'all' && g.speed !== o.speed) continue;
    if (o.minStars != null && m.stars < o.minStars) continue;
    if (o.maxStars != null && m.stars > o.maxStars) continue;
    if (o.maxLength != null && m.length > o.maxLength) continue;

    const medianPp = median(g.pps);
    const myPp = mine.get(g.key) ?? null;
    if (myPp != null && myPp >= medianPp * o.improveRatio) continue; // already farmed

    rows.push({
      beatmapId: m.beatmapId,
      beatmapsetId: m.beatmapsetId,
      artist: m.artist,
      title: m.title,
      version: m.version,
      stars: m.stars,
      length: m.length,
      bpm: m.bpm,
      speed: g.speed,
      players: g.players,
      score: Math.round(g.weight * 10) / 10,
      medianPp: Math.round(medianPp),
      minPp: Math.round(Math.min(...g.pps)),
      maxPp: Math.round(Math.max(...g.pps)),
      mods: [...g.mods.entries()].sort((a, b) => b[1] - a[1]).map(([mods, count]) => ({ mods, count })),
      myPp: myPp != null ? Math.round(myPp) : null,
      sameSongInMyBest: !myMaps.has(m.beatmapId) && mySets.has(m.beatmapsetId),
      rankIfAdded: rankIfAdded(medianPp), // where the median pp would land in your top scores
      ppGain: Math.round(gainFor(m.beatmapId, medianPp) * 10) / 10, // how much your total pp would rise
    });
  }
  rows.sort((a, b) => b.score - a.score || b.medianPp - a.medianPp);

  return {
    me: data.me,
    scope: data.scope,
    countriesUsed: data.countriesUsed ?? null,
    usedPlayers: similar.length,
    collectedPlayers: neighbors.length,
    myTop1Pp: Math.round(myBestPpAt(1)),
    myTop100Pp: Math.round(myBestPpAt(100)),
    similarPlayers: similar.slice(0, 10).map(({ id, username, pp, similarity }) => ({ id, username, pp: Math.round(pp), similarity })),
    rows: rows.slice(0, o.limit),
    totalRows: rows.length,
  };
}
