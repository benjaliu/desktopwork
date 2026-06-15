// src/router.ts
import express from 'express';
import cors from 'cors';
import { authMiddleware, generateToken } from './platform/auth.js';
import { loadConfig, updateConfig } from './platform/config.js';
import { listApps, getApp } from './platform/app-registry.js';
import { createBotChatRouter } from './apps/bot-chat/routes.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createRouter(): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Public auth endpoint
  app.post('/auth/login', (_req, res) => {
    const token = generateToken();
    res.json({ token });
  });

  // Health check (no auth)
  app.get('/api/platform/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: process.env.npm_package_version ?? '0.1.0',
      uptime: process.uptime(),
      pid: process.pid,
    });
  });

  // Authenticated platform endpoints
  app.use('/api/platform', authMiddleware);

  app.get('/api/platform/config', async (_req, res) => {
    try {
      const cfg = await loadConfig();
      res.json(cfg);
    } catch (e: any) {
      res.status(500).json({ error: 'config_load_failed', message: e.message });
    }
  });

  app.put('/api/platform/config', async (req, res) => {
    try {
      const updated = await updateConfig(req.body);
      res.json(updated);
    } catch (e: any) {
      res.status(500).json({ error: 'config_update_failed', message: e.message });
    }
  });

  app.get('/api/platform/apps', (_req, res) => {
    res.json(listApps().map(a => ({ id: a.id, name: a.name, version: a.version })));
  });

  app.get('/api/platform/apps/:id', (req, res) => {
    const app = getApp(req.params.id);
    if (!app) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ id: app.id, name: app.name, version: app.version });
  });

  app.get('/api/platform/skills', (_req, res) => {
    res.status(501).json({ error: 'not_implemented', message: 'v0.2+' });
  });

  app.put('/api/platform/skills/:id', (_req, res) => {
    res.status(501).json({ error: 'not_implemented', message: 'v0.2+' });
  });

  app.get('/api/platform/memory', (_req, res) => {
    res.status(501).json({ error: 'not_implemented', message: 'v0.4+' });
  });

  // Bot Chat App routes
  app.use('/api/bot-chat', createBotChatRouter());

  // Static files (App frontends)
  // Dev: <repo>/apps; Prod: APPS_DIR env var
  const APPS_DIR = process.env.DESKTOPWORK_APPS_DIR
    ?? join(__dirname, '..', '..', 'apps');
  app.use('/apps', express.static(APPS_DIR));

  // Root redirect
  app.get('/', (_req, res) => {
    res.redirect('/apps/dashboard/index.html');
  });

  return app;
}