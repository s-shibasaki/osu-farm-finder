// Local-only web server: serves the UI from ./public and a small JSON API.
// It listens on 127.0.0.1 so nothing is exposed to the network.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, deleteConfig } from './config.js';
import { OsuApi } from './osu-api.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

let api = null;
async function getApi() {
  if (api) return api;
  const cfg = await loadConfig();
  if (!cfg) return null;
  api = new OsuApi(cfg);
  return api;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 10_000) throw new Error('Request too large.');
  }
  return data ? JSON.parse(data) : {};
}

const routes = {
  // Whether credentials are saved (the secret itself is never sent back to the browser).
  'GET /api/config': async (req, res) => {
    const cfg = await loadConfig();
    sendJson(res, 200, { configured: !!cfg, clientId: cfg?.clientId ?? null });
  },

  // Save credentials after checking them against osu!.
  'POST /api/config': async (req, res) => {
    const { clientId, clientSecret } = await readJson(req);
    const candidate = new OsuApi({ clientId: String(clientId ?? '').trim(), clientSecret: String(clientSecret ?? '').trim() });
    await candidate.getToken(); // throws a readable error if invalid
    await saveConfig({ clientId, clientSecret });
    api = candidate;
    sendJson(res, 200, { ok: true });
  },

  'DELETE /api/config': async (req, res) => {
    await deleteConfig();
    api = null;
    sendJson(res, 200, { ok: true });
  },

  // Connection check: look up a user and return their basic stats.
  'GET /api/user': async (req, res, url) => {
    const client = await getApi();
    if (!client) return sendJson(res, 400, { error: 'Please register your osu! client ID and secret in Settings first.' });
    const name = url.searchParams.get('name');
    if (!name) return sendJson(res, 400, { error: 'Username is required.' });
    const u = await client.getUser(name);
    sendJson(res, 200, {
      id: u.id,
      username: u.username,
      country: u.country_code,
      pp: u.statistics?.pp,
      globalRank: u.statistics?.global_rank,
      countryRank: u.statistics?.country_rank,
    });
  },
};

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // Reject requests from other websites (DNS-rebinding / cross-site protection).
    const host = req.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return sendJson(res, 403, { error: 'Forbidden host' });
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return sendJson(res, 403, { error: 'Forbidden origin' });

    const handler = routes[`${req.method} ${url.pathname}`];
    try {
      if (handler) return await handler(req, res, url);
      if (req.method === 'GET') return await serveStatic(res, url.pathname);
      sendJson(res, 405, { error: 'Method not allowed' });
    } catch (e) {
      sendJson(res, e.status && e.status < 500 ? e.status : 500, { error: e.message });
    }
  });
}
