import express from 'express';
import cors from 'cors';
import authRouter, { authMiddleware } from './auth.js';
import configRouter from './config.js';
import agentRouter from './agent.js';
import skillsRouter from './skills.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createRouter() {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Auth routes (no auth required)
  app.use('/auth', authRouter);

  // Protected routes (auth required)
  app.use('/config', authMiddleware, configRouter);
  app.use('/agent', authMiddleware, agentRouter);
  app.use('/skills', authMiddleware, skillsRouter);

  // Serve HTML Apps (static files) - must be after API routes
  const appsDir = join(__dirname, '..', 'apps');
  app.use(express.static(appsDir));

  // HTML App routes
  app.get('/', (_req, res) => {
    res.sendFile(join(appsDir, 'dashboard', 'index.html'));
  });

  return app;
}