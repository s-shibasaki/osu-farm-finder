// Minimal osu! API v2 client using the client-credentials grant.
// - Requests are serialized and spaced out (default: 1 request per second).
// - 429 / 5xx responses are retried with backoff.
const BASE = 'https://osu.ppy.sh';

export class OsuApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class OsuApi {
  constructor({ clientId, clientSecret, minIntervalMs = 1000, fetchImpl = fetch }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.minIntervalMs = minIntervalMs;
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.queue = Promise.resolve();
    this.lastRequestAt = 0;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const res = await this.fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'client_credentials',
        scope: 'public',
      }),
    });
    if (!res.ok) {
      throw new OsuApiError(
        res.status === 401 || res.status === 400
          ? 'osu! rejected the client ID or secret. Please check them in Settings.'
          : `Token request failed (HTTP ${res.status}).`,
        res.status,
        res.status === 401 || res.status === 400 ? 'INVALID_CREDENTIALS' : 'TOKEN_ERROR',
      );
    }
    const json = await res.json();
    this.token = json.access_token;
    this.tokenExpiresAt = Date.now() + json.expires_in * 1000;
    return this.token;
  }

  // Serialize all API calls so we never exceed the configured rate.
  get(pathname, params = {}) {
    const run = () => this.#request(pathname, params);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async #request(pathname, params, attempt = 0) {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();

    const url = new URL(`/api/v2${pathname}`, BASE);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const token = await this.getToken();
    const res = await this.fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'x-api-version': '20240529' },
    });

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 4) throw new OsuApiError(`osu! API busy (HTTP ${res.status}). Please try again later.`, res.status, 'API_BUSY');
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt * 5;
      await sleep(retryAfter * 1000);
      return this.#request(pathname, params, attempt + 1);
    }
    if (res.status === 401 && attempt === 0) {
      this.token = null; // token may have expired early
      return this.#request(pathname, params, attempt + 1);
    }
    if (res.status === 404) throw new OsuApiError('Not found.', 404, 'NOT_FOUND');
    if (!res.ok) throw new OsuApiError(`osu! API error (HTTP ${res.status}).`, res.status, 'API_ERROR');
    return res.json();
  }

  // --- Endpoints used by this tool ---
  getUser(usernameOrId, mode = 'osu') {
    const key = /^\d+$/.test(String(usernameOrId)) ? String(usernameOrId) : `@${usernameOrId}`;
    return this.get(`/users/${encodeURIComponent(key)}/${mode}`);
  }

  getBestScores(userId, { mode = 'osu', limit = 100, offset = 0 } = {}) {
    return this.get(`/users/${userId}/scores/best`, { mode, limit, offset });
  }

  // page is 1-based; 50 users per page; the API serves up to rank 10,000 (page 200).
  getRanking({ mode = 'osu', country, page = 1 } = {}) {
    return this.get(`/rankings/${mode}/performance`, { country, 'cursor[page]': page });
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
