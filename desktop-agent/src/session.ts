import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { AgentMessage } from '@openclaw/agent-core';
import type { Session } from '@openclaw/agent-core';

// Simple fs abstraction for JsonlSessionStorage
const nodeFs = {
  async readTextFile(path: string): Promise<{ ok: true; value: string } | { ok: false; error: { code: string; message: string } }> {
    try {
      const value = readFileSync(path, 'utf-8');
      return { ok: true, value };
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        return { ok: false, error: { code: 'not_found', message: e.message } };
      }
      return { ok: false, error: { code: 'read_error', message: e.message } };
    }
  },

  async writeFile(path: string, content: string): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(path, content, 'utf-8');
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: { code: 'write_error', message: e.message } };
    }
  },

  async appendFile(path: string, content: string): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
    try {
      appendFileSync(path, content, 'utf-8');
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: { code: 'append_error', message: e.message } };
    }
  },

  async absolutePath(path: string): Promise<{ ok: true; value: string } | { ok: false; error: { code: string; message: string } }> {
    return { ok: true, value: path };
  },

  async joinPath(parts: string[]): Promise<{ ok: true; value: string } | { ok: false; error: { code: string; message: string } }> {
    return { ok: true, value: join(...parts) };
  },

  async fileInfo(path: string): Promise<{ ok: true; value: { isDirectory: boolean } } | { ok: false; error: { code: string; message: string } }> {
    try {
      const stat = existsSync(path);
      return { ok: true, value: { isDirectory: false } };
    } catch (e: any) {
      return { ok: false, error: { code: 'file_info_error', message: e.message } };
    }
  },

  async readDir(path: string): Promise<{ ok: true; value: string[] } | { ok: false; error: { code: string; message: string } }> {
    try {
      const { readdirSync } = require('node:fs');
      const files = readdirSync(path);
      return { ok: true, value: files };
    } catch (e: any) {
      return { ok: false, error: { code: 'read_dir_error', message: e.message } };
    }
  }
};

export interface SessionStore {
  getMessages(sessionKey: string): Promise<AgentMessage[]>;
  appendMessage(sessionKey: string, msg: AgentMessage): Promise<void>;
  compactIfNeeded(sessionKey: string): Promise<void>;
}

export function createSessionStore(sessionsPath: string): SessionStore {
  async function getFilePath(sessionKey: string): Promise<string> {
    const result = await nodeFs.joinPath([sessionsPath, `${sessionKey}.jsonl`]);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  async function ensureStorage(): Promise<void> {
    if (!existsSync(sessionsPath)) {
      mkdirSync(sessionsPath, { recursive: true });
    }
  }

  async function loadSession(sessionKey: string): Promise<Session | null> {
    const filePath = await getFilePath(sessionKey);
    const { JsonlSessionStorage } = await import('@openclaw/agent-core');

    const readResult = await nodeFs.readTextFile(filePath);
    if (!readResult.ok) {
      if (readResult.error.code === 'not_found') {
        return null;
      }
      throw new Error(readResult.error.message);
    }

    const storage = await JsonlSessionStorage.open(nodeFs as any, filePath);
    return storage as unknown as Session;
  }

  async function getMessages(sessionKey: string): Promise<AgentMessage[]> {
    await ensureStorage();
    const session = await loadSession(sessionKey);
    if (!session) return [];

    const entries = await session.getEntries();
    return entries
      .filter((e: any) => e.message && (e.message.role === 'user' || e.message.role === 'assistant'))
      .map((e: any) => e.message as AgentMessage);
  }

  async function appendMessage(sessionKey: string, msg: AgentMessage): Promise<void> {
    await ensureStorage();
    const filePath = await getFilePath(sessionKey);
    const { JsonlSessionStorage } = await import('@openclaw/agent-core');

    const readResult = await nodeFs.readTextFile(filePath);
    if (!readResult.ok && readResult.error.code !== 'not_found') {
      throw new Error(readResult.error.message);
    }

    let storage: any;
    if (readResult.ok) {
      storage = await JsonlSessionStorage.open(nodeFs as any, filePath);
    } else {
      // Create new session file
      storage = await JsonlSessionStorage.create(nodeFs as any, filePath, {
        sessionId: sessionKey,
        cwd: process.cwd()
      });
    }

    // Build entry from message (timestamp must be ISO string for JsonlSessionStorage)
    const ts = msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString();
    const entry = {
      id: (msg as any).id || crypto.randomUUID(),
      type: 'message' as const,
      message: msg,
      timestamp: ts,
      parentId: null
    };

    await storage.appendEntry(entry);
  }

  async function compactIfNeeded(sessionKey: string): Promise<void> {
    // TODO: Implement compaction logic
    // For now, this is a placeholder
  }

  return {
    getMessages,
    appendMessage,
    compactIfNeeded
  };
}