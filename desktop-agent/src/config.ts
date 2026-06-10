import { Router } from 'express';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const router = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(process.env.HOME || '', '.config', 'desktopwork');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface AppConfig {
  id: string;
  title: string;
  icon?: string;
  url: string;
}

export interface AgentConfig {
  model: string;
  provider: string;
  apiKey: string;
  baseUrl: string;
}

export interface Config {
  apps: AppConfig[];
  agent: AgentConfig;
}

const DEFAULT_CONFIG: Config = {
  apps: [
    { id: 'dashboard', title: 'Dashboard', url: '/' },
    { id: 'chat', title: 'Chat', url: '/chat' },
    { id: 'settings', title: 'Settings', url: '/settings' },
  ],
  agent: {
    model: 'gpt-4o',
    provider: 'openai',
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
  },
};

async function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true });
  }
}

async function loadConfig(): Promise<Config> {
  await ensureConfigDir();
  if (!existsSync(CONFIG_FILE)) {
    await saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  try {
    const raw = await readFile(CONFIG_FILE, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function saveConfig(config: Config): Promise<void> {
  await ensureConfigDir();
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// GET /config
router.get('/', async (_req, res) => {
  try {
    const config = await loadConfig();
    return res.json(config);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// PATCH /config
router.patch('/', async (req, res) => {
  try {
    const config = await loadConfig();
    const patched = { ...config, ...req.body };
    await saveConfig(patched);
    return res.json(patched);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

// GET /config/apps/:appId
router.get('/apps/:appId', async (req, res) => {
  const config = await loadConfig();
  const app = config.apps.find((a) => a.id === req.params.appId);
  if (!app) return res.status(404).json({ error: 'app not found' });
  return res.json(app);
});

// PATCH /config/apps/:appId
router.patch('/apps/:appId', async (req, res) => {
  const config = await loadConfig();
  const idx = config.apps.findIndex((a) => a.id === req.params.appId);
  if (idx === -1) return res.status(404).json({ error: 'app not found' });
  config.apps[idx] = { ...config.apps[idx], ...req.body };
  await saveConfig(config);
  return res.json(config.apps[idx]);
});

// GET /config/agent
router.get('/agent', async (_req, res) => {
  const config = await loadConfig();
  return res.json(config.agent);
});

// PATCH /config/agent
router.patch('/agent', async (req, res) => {
  try {
    const config = await loadConfig();
    config.agent = { ...config.agent, ...req.body };
    await saveConfig(config);
    return res.json(config.agent);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

export default router;