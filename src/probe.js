// Experiment: how often does a random user id belong to a player with pp close to the target?
// Used to decide whether "random id sampling" is practical for players outside the top 10,000.
// Run: npx --yes github:s-shibasaki/osu-farm-finder#probe-sampling --probe=<username> [--calls=100]
import { loadConfig } from './config.js';
import { OsuApi } from './osu-api.js';

const BUCKETS = 10;

export async function runProbe({ username, calls = 100 }) {
  const cfg = await loadConfig();
  if (!cfg) {
    console.error('先に通常どおりツールを起動し、「⚙ 設定」でクライアントID とシークレットを登録してください。');
    process.exit(1);
  }
  const api = new OsuApi(cfg);
  const u = await api.getUser(username);
  const pp = u.statistics?.pp ?? 0;
  // Highest id to sample: a bit above the target's id (newer accounts exist too).
  const maxId = Math.round(Math.max(u.id, 40_000_000) * 1.03);
  console.log(`対象: ${u.username}（id ${u.id}、${Math.round(pp)}pp、国内 #${u.statistics?.country_rank ?? '-'}）`);
  console.log(`ユーザーID 1〜${maxId.toLocaleString()} から、50件ずつ ${calls} 回（計 ${calls * 50} 件）無作為に問い合わせます。約 ${Math.ceil(calls / 60)} 分かかります。\n`);

  const windows = [0.05, 0.1, 0.15, 0.25];
  const hits = Object.fromEntries(windows.map((w) => [w, 0]));
  const hitsJP = Object.fromEntries(windows.map((w) => [w, 0]));
  const bucket = Array.from({ length: BUCKETS }, () => ({ asked: 0, found: 0, withPp: 0, near: 0 }));
  let found = 0;
  let withPp = 0;
  const started = Date.now();

  for (let c = 0; c < calls; c++) {
    // Stratified: each call samples one id-range bucket in turn, so every range is measured evenly.
    const b = c % BUCKETS;
    const lo = Math.floor((maxId * b) / BUCKETS) + 1;
    const hi = Math.floor((maxId * (b + 1)) / BUCKETS);
    const ids = new Set();
    while (ids.size < 50) ids.add(lo + Math.floor(Math.random() * (hi - lo + 1)));
    const res = await api.getUsers([...ids]);
    const users = res.users ?? [];
    bucket[b].asked += 50;
    bucket[b].found += users.length;
    found += users.length;
    for (const x of users) {
      const p = x.statistics_rulesets?.osu?.pp ?? 0;
      if (p > 0) {
        withPp++;
        bucket[b].withPp++;
      }
      const ratio = Math.abs(p - pp) / pp;
      for (const w of windows) {
        if (p > 0 && ratio <= w) {
          hits[w]++;
          if (x.country_code === u.country_code) hitsJP[w]++;
        }
      }
      if (p > 0 && ratio <= 0.15) bucket[b].near++;
    }
    process.stdout.write(`\r  ${c + 1} / ${calls} 回`);
  }
  const sec = (Date.now() - started) / 1000;
  console.log(`\n\n結果（${sec.toFixed(0)} 秒）`);
  console.log(`  存在したアカウント: ${found} / ${calls * 50}`);
  console.log(`  osu! の pp を持つアカウント: ${withPp}`);
  for (const w of windows) {
    const per = hits[w] / calls;
    const callsFor250 = per ? Math.ceil(250 / per) : Infinity;
    console.log(
      `  pp が ±${w * 100}% 以内: ${hits[w]} 人（うち同じ国 ${hitsJP[w]} 人）` +
        ` → 250人集めるのに約 ${callsFor250 === Infinity ? '?' : Math.ceil(callsFor250 / 60)} 分`,
    );
  }
  console.log('\nユーザーIDの範囲ごと（±15% 以内の人数）');
  bucket.forEach((x, i) => {
    const lo = Math.floor((maxId * i) / BUCKETS) + 1;
    const hi = Math.floor((maxId * (i + 1)) / BUCKETS);
    console.log(`  ${String(lo).padStart(10)}〜${String(hi).padEnd(10)} 問い合わせ ${x.asked}  存在 ${x.found}  pp あり ${x.withPp}  近い人 ${x.near}`);
  });
  console.log('\nこの結果を、そのままチャットに貼り付けてください。');
}
