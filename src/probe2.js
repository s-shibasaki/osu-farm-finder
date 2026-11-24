// Experiment 2: two ways to find players with pp close to a target outside the top 10,000.
//  Part 1: rankings of other countries (in smaller countries, low-pp players are within the top 10,000)
//  Part 2: participants of the latest daily challenge (official API, read from the lowest scores)
// Run: npx --yes github:s-shibasaki/osu-farm-finder#probe-sampling --probe2=<username>
import { loadConfig } from './config.js';
import { OsuApi } from './osu-api.js';

const WINDOW = 0.15; // "close" = within ±15% pp

export async function runProbe2({ username, maxCountryCalls = 120 }) {
  const cfg = await loadConfig();
  if (!cfg) {
    console.error('先に通常どおりツールを起動し、「⚙ 設定」でクライアントID とシークレットを登録してください。');
    process.exit(1);
  }
  const api = new OsuApi(cfg);
  const u = await api.getUser(username);
  const pp = u.statistics?.pp ?? 0;
  const lo = pp * (1 - WINDOW);
  const hi = pp * (1 + WINDOW);
  console.log(`対象: ${u.username}（${Math.round(pp)}pp、国内 #${u.statistics?.country_rank ?? '-'}）`);
  console.log(`「近い人」= pp が ${Math.round(lo)}〜${Math.round(hi)} の人\n`);

  // ---------- Part 1: other countries' rankings ----------
  console.log('【1】ほかの国のランキングから探す');
  const t1 = Date.now();
  const s1 = { ...api.stats };
  const countries = [];
  for (let page = 1; page <= 3; page++) {
    const r = await api.getCountryRanking({ page });
    for (const c of r.ranking ?? []) countries.push({ code: c.code ?? c.country?.code, active: c.active_users });
  }
  countries.sort((a, b) => b.active - a.active);

  const found = new Map();
  const perCountry = [];
  let calls = 0;
  for (const c of countries) {
    if (calls >= maxCountryCalls || found.size >= 300) break;
    const cache = new Map();
    const page = async (p) => {
      if (!cache.has(p)) {
        calls++;
        const r = await api.getRanking({ country: c.code, page: p });
        cache.set(p, (r.ranking ?? []).map((x) => ({ id: x.user.id, pp: x.pp, country: c.code })));
      }
      return cache.get(p);
    };
    const callsBefore = calls;
    // Is the target's pp inside this country's top 10,000? Look at the last page first.
    const last = await page(200);
    if (last.length && last.at(-1).pp > hi) {
      perCountry.push(`${c.code}: 範囲外（1万位でも ${Math.round(last.at(-1).pp)}pp）`);
      continue;
    }
    // Binary search for the first page whose lowest pp is <= target pp.
    let a = 1;
    let b = 200;
    while (a < b) {
      const m = (a + b) >> 1;
      const rows = await page(m);
      if (rows.length && rows.at(-1).pp > pp) a = m + 1;
      else b = m;
    }
    let got = 0;
    for (let p = Math.max(1, a - 2); p <= Math.min(200, a + 2); p++) {
      for (const x of await page(p)) {
        if (x.pp >= lo && x.pp <= hi && x.id !== u.id && !found.has(x.id)) {
          found.set(x.id, x);
          got++;
        }
      }
    }
    perCountry.push(`${c.code}: ${got}人（問い合わせ ${calls - callsBefore}回）`);
  }
  const sec1 = (Date.now() - t1) / 1000;
  console.log(`  ${perCountry.join(' / ')}`);
  console.log(`  → 近い人 ${found.size}人、問い合わせ ${calls}回、${sec1.toFixed(0)}秒\n`);
  report(api, s1, '  ');

  // ---------- Part 2: daily challenge ----------
  console.log('\n【2】デイリーチャレンジの参加者から探す');
  const t2 = Date.now();
  const s2 = { ...api.stats };
  try {
    let rooms = await api.getRooms({ mode: 'ended', sort: 'ended', limit: 50 });
    rooms = Array.isArray(rooms) ? rooms : rooms.rooms ?? [];
    const dc = rooms.find((r) => r.category === 'daily_challenge');
    if (!dc) {
      console.log(`  デイリーチャレンジのルームが見つかりませんでした（取得したルーム ${rooms.length}件、種類: ${[...new Set(rooms.map((r) => r.category))].join(',')}）`);
    } else {
      const playlistId = dc.playlist?.[0]?.id ?? dc.current_playlist_item?.id;
      console.log(`  ルーム ${dc.id}「${dc.name}」（プレイリスト ${playlistId}、参加者 ${dc.participant_count ?? '?'}人）`);
      const ids = [];
      let total = null;
      for (const sort of ['score_asc', 'score_desc']) {
        let cursor;
        for (let i = 0; i < (sort === 'score_asc' ? 4 : 2); i++) {
          const r = await api.getPlaylistScores(dc.id, playlistId, { limit: 50, sort, cursor_string: cursor });
          total = r.total ?? total;
          for (const s of r.scores ?? []) ids.push({ id: s.user_id ?? s.user?.id, from: sort });
          cursor = r.cursor_string;
          if (!cursor) break;
        }
      }
      console.log(`  スコア総数（API の total）: ${total ?? '?'}、読み込んだ参加者 ${ids.length}人`);
      const users = [];
      const uniq = [...new Map(ids.map((x) => [x.id, x])).values()];
      for (let i = 0; i < uniq.length; i += 50) {
        const r = await api.getUsers(uniq.slice(i, i + 50).map((x) => x.id));
        for (const x of r.users ?? []) users.push({ pp: x.statistics_rulesets?.osu?.pp ?? 0, country: x.country_code, from: uniq.find((y) => y.id === x.id)?.from });
      }
      for (const from of ['score_asc', 'score_desc']) {
        const g = users.filter((x) => x.from === from).map((x) => x.pp).sort((a, b) => a - b);
        if (!g.length) continue;
        const q = (f) => Math.round(g[Math.floor(f * (g.length - 1))]);
        const near = g.filter((p) => p >= lo && p <= hi).length;
        console.log(
          `  ${from === 'score_asc' ? 'スコア下位' : 'スコア上位'} ${g.length}人: pp 最小 ${q(0)}／25% ${q(0.25)}／中央 ${q(0.5)}／75% ${q(0.75)}／最大 ${q(1)}、近い人 ${near}人`,
        );
      }
      console.log(`  うち日本のプレイヤー: ${users.filter((x) => x.country === u.country_code).length}人`);
    }
  } catch (e) {
    console.log(`  エラー: ${e.message}（HTTP ${e.status ?? '-'}）`);
  }
  console.log(`  ${((Date.now() - t2) / 1000).toFixed(0)}秒`);
  report(api, s2, '  ');
  console.log('\nこの結果を、そのままチャットに貼り付けてください。');
}

function report(api, before, indent) {
  const n = api.stats.requests - before.requests;
  const avg = n ? (api.stats.responseMs - before.responseMs) / n / 1000 : 0;
  console.log(
    `${indent}[診断] 問い合わせ ${n}回、平均応答 ${avg.toFixed(2)}秒、混雑による待ち ${api.stats.retries - before.retries}回（計 ${((api.stats.waitMs - before.waitMs) / 1000).toFixed(0)}秒）`,
  );
}
