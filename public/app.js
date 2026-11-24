const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------- helpers ----------
class ApiError extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('offline', 'OFFLINE');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error || `HTTP ${res.status}`, json.code, json.details);
  return json;
}

// Japanese text for error codes sent by the server.
function errorText(code, details, fallback) {
  switch (code) {
    case 'NOT_CONFIGURED': return '先に「⚙ 設定」で osu! のクライアントID とシークレットを登録してください。';
    case 'INVALID_CREDENTIALS': return 'osu! にクライアントID またはシークレットが正しくないと判断されました。前後に空白が入っていないかも確かめて、入力し直してください。';
    case 'TOKEN_ERROR': return 'osu! への認証に失敗しました。しばらくしてから、もう一度お試しください。';
    case 'NOT_FOUND': return 'そのユーザー名のプレイヤーが見つかりませんでした。つづりを確かめてください。';
    case 'API_BUSY': return 'osu! が混み合っているため、データを取得できませんでした。しばらく待ってから、もう一度お試しください。途中までのデータは保存されているので、続きから再開できます。';
    case 'API_ERROR': return 'osu! からエラーが返されました。しばらくしてから、もう一度お試しください。';
    case 'NO_RANK': return 'このプレイヤーにはまだ順位がないため、比べる相手を探せません。';
    case 'OUT_OF_RANGE': {
      const where = details?.scope === 'global' ? '世界' : '国内';
      const other = details?.scope === 'global' ? '' : '「比べる相手」を「世界のプレイヤー」にしても範囲外の場合は、';
      return `osu! の API で取得できるランキングは上位${(details?.limit ?? 10000).toLocaleString()}位までですが、このプレイヤーの${where}順位は ${details?.rank?.toLocaleString() ?? '?'}位のため、現在は対応していません。${other}今後の対応をお待ちください。`;
    }
    case 'USERNAME_REQUIRED': return 'ユーザー名を入力してください。';
    case 'BAD_COUNT': return '集める人数は、20〜1000人の範囲で指定してください。';
    case 'JOB_RUNNING': return '別の取得がまだ動いています。終わるまで待つか、「中止」を押してください。';
    case 'JOB_NOT_FOUND': return '取得結果が見つかりませんでした。ツールを再起動した場合は、もう一度「調べる」を押してください。';
    case 'OFFLINE': return 'ツールのサーバーに接続できません。ツールを起動したターミナルが開いたままか確かめてください。';
    default: return `予期しないエラーが発生しました（${fallback}）。`;
  }
}

function showMessage(text, kind = 'error') {
  const el = $('#message');
  el.textContent = text;
  el.className = `message ${kind}`;
  el.hidden = !text;
}

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtLen = (s) => (s == null ? '-' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
const fmtPp = (n) => Math.round(n).toLocaleString();

// ---------- settings ----------
async function refreshConfig() {
  const cfg = await api('GET', '/api/config');
  $('#config-status').textContent = cfg.configured
    ? `✅ 登録済みです（クライアントID: ${cfg.clientId}）。変更する場合は、もう一度入力してください。`
    : 'まだ登録されていません。';
  $('#config-status').className = `status ${cfg.configured ? 'ok' : ''}`;
  return cfg.configured;
}

$('#open-settings').addEventListener('click', () => $('#settings').showModal());

$('#config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#config-status').textContent = 'osu! に確認しています…';
  try {
    await api('POST', '/api/config', { clientId: f.get('clientId'), clientSecret: f.get('clientSecret') });
    e.target.reset();
    await refreshConfig();
    showMessage('');
  } catch (err) {
    $('#config-status').textContent = `保存できませんでした。${errorText(err.code, err.details, err.message)}`;
    $('#config-status').className = 'status error';
  }
});

$('#config-delete').addEventListener('click', async () => {
  await api('DELETE', '/api/config');
  await refreshConfig();
});

// ---------- search & progress ----------
const PHASES = ['user', 'myBest', 'ranking', 'neighbors'];
let jobId = null;

function setRunning(running) {
  $('#search-start').disabled = running;
  $('#search-cancel').hidden = !running;
}

function showProgress(job) {
  const p = job.progress ?? {};
  $('#progress-card').hidden = false;
  const idx = PHASES.indexOf(p.phase);
  $$('#steps li').forEach((li, i) => {
    li.className = p.phase === 'done' || i < idx ? 'done' : i === idx ? 'now' : '';
  });
  $('#progress-bar').value = p.phase === 'done' ? 1 : p.total ? p.done / p.total : 0;
  let text = '';
  if (p.phase === 'neighbors' && p.total) {
    const eta = p.etaSec == null ? '' : p.etaSec < 60 ? `残り約${p.etaSec}秒` : `残り約${Math.ceil(p.etaSec / 60)}分`;
    text = `${p.done} / ${p.total} 人${eta ? `（${eta}）` : ''}`;
  } else if (p.phase === 'ranking' && p.total) {
    text = `${p.done} / ${p.total} ページ`;
  } else if (p.phase !== 'done') {
    text = '取得しています…';
  }
  $('#progress-text').textContent = text;
}

async function poll() {
  if (!jobId) return;
  let job;
  try {
    job = await api('GET', `/api/jobs/${jobId}`);
  } catch (err) {
    setRunning(false);
    return showMessage(errorText(err.code, err.details, err.message));
  }
  showProgress(job);
  if (job.status === 'running') return setTimeout(poll, 1000);

  setRunning(false);
  refreshCache();
  if (job.status === 'done') {
    $('#progress-card').hidden = true;
    loadResults();
  } else if (job.status === 'cancelled') {
    showMessage('中止しました。それまでに取得したデータは保存されているので、もう一度「調べる」を押すと続きから再開できます。', 'info');
  } else {
    showMessage(errorText(job.errorCode, job.errorDetails, job.error));
  }
}

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const username = String(f.get('username')).trim();
  localStorage.setItem('off:username', username);
  localStorage.setItem('off:scope', f.get('scope'));
  showMessage('');
  $('#results').hidden = true;
  try {
    const job = await api('POST', '/api/jobs', { username, scope: f.get('scope'), count: Number(f.get('count')) });
    jobId = job.id;
    setRunning(true);
    showProgress(job);
    poll();
  } catch (err) {
    showMessage(errorText(err.code, err.details, err.message));
    if (err.code === 'NOT_CONFIGURED') $('#settings').showModal();
  }
});

$('#search-cancel').addEventListener('click', () => jobId && api('DELETE', `/api/jobs/${jobId}`));

// ---------- results ----------
const filters = { speed: 'all', sort: null, sortDir: -1 };
let lastResult = null;

function currentQuery() {
  const q = new URLSearchParams();
  if (filters.speed !== 'all') q.set('speed', filters.speed);
  for (const [id, key] of [['#f-minStars', 'minStars'], ['#f-maxStars', 'maxStars'], ['#f-maxLength', 'maxLength'], ['#f-minPlayers', 'minPlayers']]) {
    const v = $(id).value;
    if (v !== '') q.set(key, v);
  }
  return q;
}

async function loadResults() {
  if (!jobId) return;
  try {
    lastResult = await api('GET', `/api/jobs/${jobId}/recommendations?${currentQuery()}`);
  } catch (err) {
    return showMessage(errorText(err.code, err.details, err.message));
  }
  renderResults();
}

function renderResults() {
  const r = lastResult;
  if (!r) return;
  $('#results').hidden = false;

  $('#result-summary').innerHTML =
    `<strong>${esc(r.me.username)}</strong>（${fmtPp(r.me.pp)}pp）さんと pp が近い${r.scope === 'global' ? '世界' : '国内'}のプレイヤー ${r.collectedPlayers} 人を集め、` +
    `ベストスコアの重なりが大きい ${r.usedPlayers} 人を「似たプレイヤー」として比べました。<br>` +
    `あなたのベストスコアは、1位が <strong>${r.myTop1Pp}pp</strong>、100位が <strong>${r.myTop100Pp}pp</strong> です。` +
    `「入る順位」が小さい譜面ほど、取れたときに総 pp が大きく伸びます。`;

  $('#similar-list').innerHTML = r.similarPlayers
    .map((p) => `<li><a href="https://osu.ppy.sh/users/${p.id}" target="_blank" rel="noopener">${esc(p.username)}</a>（${fmtPp(p.pp)}pp・重なり ${p.similarity} 点）</li>`)
    .join('');

  let rows = r.rows;
  if (!$('#f-retry').checked) rows = rows.filter((x) => x.myPp == null);
  if (filters.sort) {
    const k = filters.sort;
    rows = [...rows].sort((a, b) => ((a[k] ?? 0) - (b[k] ?? 0)) * filters.sortDir);
  }
  $$('th.sortable').forEach((th) => {
    th.dataset.dir = th.dataset.sort === filters.sort ? (filters.sortDir > 0 ? '▲' : '▼') : '';
  });

  const maxPlayers = Math.max(1, ...rows.map((x) => x.players));
  $('#result-count').textContent = rows.length
    ? `${rows.length} 件${r.totalRows > r.rows.length ? `（条件に合う ${r.totalRows} 件のうち上位 ${r.rows.length} 件から表示）` : ''}。列の見出しを押すと並べ替えられます。`
    : '条件に合う譜面がありません。絞り込みの条件をゆるめてみてください。';

  $('#result-table tbody').innerHTML = rows
    .map((x) => {
      const badges = [];
      if (x.myPp != null) badges.push(`<span class="badge retry" title="あなたのベストスコアに入っていますが、似たプレイヤーよりかなり低い pp です">取り直し候補：現在 ${x.myPp}pp</span>`);
      if (x.sameSongInMyBest) badges.push('<span class="badge same" title="同じ曲の別の難易度が、あなたのベストスコアに入っています">別難易度で取得済みの曲</span>');
      const mods = x.mods.slice(0, 3).map((m) => `<span class="mod">${esc(m.mods)}</span><small>×${m.count}</small>`).join(' ');
      return `<tr>
        <td class="map">
          <img src="https://assets.ppy.sh/beatmaps/${x.beatmapsetId}/covers/list.jpg" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
          <div>
            <a href="https://osu.ppy.sh/beatmapsets/${x.beatmapsetId}#osu/${x.beatmapId}" target="_blank" rel="noopener">
              <span class="title">${esc(x.title)}</span> <span class="ver">[${esc(x.version)}]</span>
            </a>
            <div class="artist">${esc(x.artist)}・BPM ${x.bpm ?? '-'}</div>
            ${badges.length ? `<div class="badges">${badges.join(' ')}</div>` : ''}
          </div>
        </td>
        <td class="num">${x.stars != null ? x.stars.toFixed(2) : '-'}</td>
        <td class="num">${fmtLen(x.length)}</td>
        <td><span class="speed s-${x.speed}">${{ NM: '等速', DT: 'DT', HT: 'HT' }[x.speed]}</span></td>
        <td class="num"><div class="bar"><i style="width:${(x.players / maxPlayers) * 100}%"></i></div>${x.players}人</td>
        <td class="num" title="最小 ${x.minPp}pp ～ 最大 ${x.maxPp}pp"><strong>${x.medianPp}</strong></td>
        <td>${mods}</td>
        <td class="num">#${x.rankIfAdded}</td>
      </tr>`;
    })
    .join('');
}

$$('#speed-seg button').forEach((b) =>
  b.addEventListener('click', () => {
    $$('#speed-seg button').forEach((x) => x.classList.toggle('on', x === b));
    filters.speed = b.dataset.speed;
    loadResults();
  }),
);
for (const id of ['#f-minStars', '#f-maxStars', '#f-maxLength', '#f-minPlayers']) $(id).addEventListener('change', loadResults);
$('#f-retry').addEventListener('change', renderResults);
$$('th.sortable').forEach((th) =>
  th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (filters.sort === k) filters.sortDir *= -1;
    else {
      filters.sort = k;
      filters.sortDir = k === 'rankIfAdded' || k === 'length' ? 1 : -1;
    }
    renderResults();
  }),
);

// ---------- cache ----------
async function refreshCache() {
  try {
    const s = await api('GET', '/api/cache');
    $('#cache-stats').textContent = `${s.entries.toLocaleString()} 件（${(s.bytes / 1024 / 1024).toFixed(1)} MB）`;
  } catch {
    $('#cache-stats').textContent = '-';
  }
}

$('#cache-clear').addEventListener('click', async () => {
  if (!$('#search-cancel').hidden) return showMessage('取得中は削除できません。終わるまで待つか、「中止」を押してください。');
  await api('DELETE', '/api/cache');
  refreshCache();
  showMessage('一時保存データを削除しました。次回の取得では、すべてのデータを取り直します。', 'info');
});

// ---------- start up ----------
(async () => {
  $('#search-form [name=username]').value = localStorage.getItem('off:username') ?? '';
  $('#search-form [name=scope]').value = localStorage.getItem('off:scope') ?? 'country';
  refreshCache();
  try {
    if (!(await refreshConfig())) $('#settings').showModal();
    // Resume a running job, or show the last result after a page reload.
    const latest = await api('GET', '/api/jobs/latest');
    if (latest) {
      jobId = latest.id;
      if (latest.status === 'running') {
        setRunning(true);
        showProgress(latest);
        poll();
      } else {
        loadResults();
      }
    }
  } catch (err) {
    showMessage(errorText(err.code, err.details, err.message));
  }
})();
