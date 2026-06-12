// src/apps/bot-chat/routes.ts
import { Router } from 'express';
import { authMiddleware } from '../../platform/auth.js';
import { botChatService } from './service.js';
import type { ChatRequest } from './types.js';

export function createBotChatRouter(): Router {
  const router = Router();
  router.use(authMiddleware);

  // POST /chat
  router.post('/chat', async (req, res) => {
    const { message, sessionId, stream = true } = req.body as ChatRequest;
    if (!message) {
      res.status(400).json({ error: 'message_required' });
      return;
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      try {
        for await (const event of botChatService.streamChat({ message, sessionId, stream: true }, (req as any).signal)) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        res.end();
      } catch (e: any) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
        res.end();
      }
    } else {
      try {
        const result = await botChatService.chat({ message, sessionId, stream: false });
        res.json(result);
      } catch (e: any) {
        res.status(500).json({ error: 'chat_failed', message: e.message });
      }
    }
  });

  // GET /sessions
  router.get('/sessions', async (_req, res) => {
    try {
      const sessions = await botChatService.listSessions();
      res.json(sessions);
    } catch (e: any) {
      res.status(500).json({ error: 'list_sessions_failed', message: e.message });
    }
  });

  // GET /sessions/:id
  router.get('/sessions/:id', async (req, res) => {
    try {
      const messages = await botChatService.getMessages(req.params.id);
      res.json(messages);
    } catch (e: any) {
      res.status(500).json({ error: 'get_messages_failed', message: e.message });
    }
  });

  // DELETE /sessions/:id
  router.delete('/sessions/:id', async (req, res) => {
    try {
      await botChatService.deleteSession(req.params.id);
      res.status(204).end();
    } catch (e: any) {
      res.status(500).json({ error: 'delete_session_failed', message: e.message });
    }
  });

  // PUT /sessions/:id
  router.put('/sessions/:id', async (req, res) => {
    const { title } = req.body as { title?: string };
    if (!title) {
      res.status(400).json({ error: 'title_required' });
      return;
    }
    try {
      await botChatService.renameSession(req.params.id, title);
      res.status(204).end();
    } catch (e: any) {
      res.status(500).json({ error: 'rename_session_failed', message: e.message });
    }
  });

  // TODO §10.2+: POST /sessions/:id/fork (forkSession)
  // TODO §10.2+: GET /sessions/:id/info (getSessionInfo)

  return router;
}