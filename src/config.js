// Stores the user's own osu! OAuth client credentials on their machine.
// The file lives in ~/.osu-farm-finder/config.json and is readable only by the owner.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA_DIR = process.env.OSU_FARM_FINDER_HOME || path.join(os.homedir(), '.osu-farm-finder');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg.clientId === 'string' && typeof cfg.clientSecret === 'string') return cfg;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[config] could not read ${CONFIG_PATH}: ${e.message}`);
  }
  return null;
}

export async function saveConfig({ clientId, clientSecret }) {
  if (!/^\d+$/.test(String(clientId ?? '').trim())) throw new Error('Client ID must be a number.');
  if (!String(clientSecret ?? '').trim()) throw new Error('Client secret is empty.');
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ clientId: String(clientId).trim(), clientSecret: String(clientSecret).trim() }, null, 2);
  await fs.writeFile(CONFIG_PATH, body, { mode: 0o600 });
  await fs.chmod(CONFIG_PATH, 0o600).catch(() => {}); // no-op on Windows
}

export async function deleteConfig() {
  await fs.rm(CONFIG_PATH, { force: true });
}

export function configPath() {
  return CONFIG_PATH;
}
