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

refreshConfig();
