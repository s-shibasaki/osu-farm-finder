const $ = (s) => document.querySelector(s);

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function refreshConfig() {
  const cfg = await api('GET', '/api/config');
  $('#config-status').textContent = cfg.configured
    ? `保存済みです（クライアントID: ${cfg.clientId}）。`
    : 'まだ登録されていません。';
}

$('#config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#config-status').textContent = '確認しています…';
  try {
    await api('POST', '/api/config', { clientId: f.get('clientId'), clientSecret: f.get('clientSecret') });
    e.target.reset();
    await refreshConfig();
  } catch (err) {
    $('#config-status').textContent = `保存できませんでした：${err.message}`;
  }
});

$('#config-delete').addEventListener('click', async () => {
  await api('DELETE', '/api/config');
  await refreshConfig();
});

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = new FormData(e.target).get('name');
  $('#user-result').textContent = '問い合わせています…';
  try {
    const u = await api('GET', `/api/user?name=${encodeURIComponent(name)}`);
    $('#user-result').textContent =
      `${u.username}（${u.country}）\n` +
      `pp: ${Math.round(u.pp).toLocaleString()}\n` +
      `世界順位: #${u.globalRank?.toLocaleString() ?? '-'} / 国内順位: #${u.countryRank?.toLocaleString() ?? '-'}`;
  } catch (err) {
    $('#user-result').textContent = `エラー：${err.message}`;
  }
});

// ---- Data collection (step 2) ----
const PHASE_LABEL = {
  start: '準備しています',
  user: 'プレイヤー情報を調べています',
  myBest: 'あなたのベストスコアを取得しています',
  ranking: 'ランキングを読み込んでいます',
  neighbors: 'pp が近いプレイヤーのベストスコアを取得しています',
  done: '完了しました',
};
let currentJob = null;
let lastJobStatus = null;
let doneJob = null;

function formatEta(sec) {
  if (sec == null) return '';
  if (sec < 60) return `（残り約${sec}秒）`;
  return `（残り約${Math.ceil(sec / 60)}分）`;
}

function showJob(job) {
  const p = job.progress ?? {};
  const bar = $('#collect-progress');
  const running = job.status === 'running';
  $('#collect-start').disabled = running;
  $('#collect-cancel').hidden = !running;
  bar.hidden = false;
  bar.value = p.total ? p.done / p.total : running ? 0 : 1;

  if (job.status === 'running') {
    const count = p.total ? ` ${p.done} / ${p.total}` : '';
    $('#collect-status').textContent = `${PHASE_LABEL[p.phase] ?? p.phase}…${count}${p.phase === 'neighbors' ? formatEta(p.etaSec) : ''}`;
  } else if (job.status === 'done') {
    const s = job.summary;
    $('#collect-status').textContent =
      `取得が完了しました。\n` +
      `対象：${s.me.username}（${Math.round(s.me.pp).toLocaleString()}pp）／ベストスコア ${s.myBest} 件\n` +
      `比べる相手：${s.scope === 'global' ? '世界' : '同じ国'}のプレイヤー ${s.neighbors} 人` +
      (s.ppRange ? `（${Math.round(s.ppRange[0]).toLocaleString()}〜${Math.round(s.ppRange[1]).toLocaleString()}pp）` : '');
  } else if (job.status === 'cancelled') {
    $('#collect-status').textContent = '中止しました。それまでに取得したデータは一時保存されているので、続きから再開できます。';
  } else {
    $('#collect-status').textContent = `取得できませんでした：${job.error}`;
  }
}

async function pollJob() {
  if (!currentJob) return;
  try {
    const job = await api('GET', `/api/jobs/${currentJob}`);
    showJob(job);
    lastJobStatus = job.status;
    if (job.status === 'running') return setTimeout(pollJob, 1000);
  } catch (err) {
    $('#collect-status').textContent = `状態を確認できませんでした：${err.message}`;
  }
  if (lastJobStatus === 'done') loadRecommendations();
  else currentJob = null;
  refreshCache();
}

$('#collect-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const job = await api('POST', '/api/jobs', {
      username: f.get('username'),
      scope: f.get('scope'),
      count: Number(f.get('count')),
    });
    currentJob = job.id;
    showJob(job);
    pollJob();
  } catch (err) {
    $('#collect-status').textContent = `開始できませんでした：${err.message}`;
  }
});

// ---- Recommendations (step 3, temporary table) ----
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtLen = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const SPEED_LABEL = { NM: '等速', DT: 'DT', HT: 'HT' };

async function loadRecommendations() {
  if (currentJob) doneJob = currentJob;
  currentJob = null;
  if (!doneJob) return;
  const f = new FormData($('#rec-form'));
  const q = new URLSearchParams();
  for (const [k, v] of f) if (v !== '') q.set(k, v);
  try {
    const r = await api('GET', `/api/jobs/${doneJob}/recommendations?${q}`);
    $('#rec').hidden = false;
    $('#rec-summary').textContent =
      `集めた ${r.collectedPlayers} 人のうち、ベストスコアの重なりが大きい ${r.usedPlayers} 人を「似たプレイヤー」として使いました。` +
      `あなたのベストスコアは1位が ${r.myTop1Pp}pp、100位が ${r.myTop100Pp}pp です。該当 ${r.totalRows} 件（上位 ${r.rows.length} 件を表示）。`;
    $('#rec-table').innerHTML =
      '<tr><th>譜面</th><th>★</th><th>長さ</th><th>速さ</th><th>取得人数</th><th>中央値pp</th><th>よく使われるMod</th><th>あなたの現在pp</th><th>入る順位</th></tr>' +
      r.rows.map((x) => `<tr>
        <td><a href="https://osu.ppy.sh/b/${x.beatmapId}" target="_blank" rel="noopener">${esc(x.artist)} - ${esc(x.title)} [${esc(x.version)}]</a>${x.sameSongInMyBest ? ' <small>（別難易度で取得済みの曲）</small>' : ''}</td>
        <td>${x.stars?.toFixed(2) ?? '-'}</td><td>${x.length != null ? fmtLen(x.length) : '-'}</td>
        <td>${SPEED_LABEL[x.speed]}</td><td>${x.players}人</td><td>${x.medianPp}</td>
        <td>${x.mods.slice(0, 3).map((m) => `${esc(m.mods)}×${m.count}`).join(' ')}</td>
        <td>${x.myPp ?? '-'}</td><td>#${x.rankIfAdded}</td></tr>`).join('');
  } catch (err) {
    $('#rec-summary').textContent = `計算できませんでした：${err.message}`;
  }
}

$('#rec-form').addEventListener('submit', (e) => {
  e.preventDefault();
  loadRecommendations();
});

$('#collect-cancel').addEventListener('click', async () => {
  if (currentJob) await api('DELETE', `/api/jobs/${currentJob}`);
});

async function refreshCache() {
  const s = await api('GET', '/api/cache');
  $('#cache-stats').textContent = `${s.entries.toLocaleString()} 件（${(s.bytes / 1024 / 1024).toFixed(1)} MB）`;
}

$('#cache-clear').addEventListener('click', async () => {
  await api('DELETE', '/api/cache');
  refreshCache();
});

refreshConfig();
refreshCache();
