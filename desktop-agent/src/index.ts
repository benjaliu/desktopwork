import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { startIpcLoop, type StreamWriter } from './ipc.js';
import type { Request, Response, ChatParams, StreamEvent, StatusResult } from './types.js';
import { createAgent } from './agent.js';
import type { Agent } from './agent.js';
import { loadUserSkills, reloadSkills } from './skills.js';

const VERSION = "0.1.0";

function resolveDataDir(): string {
  const home = homedir();
  // Cross-platform data directory
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || home, 'desktopwork', '.openclaw');
  } else {
    return join(home, '.local', 'share', 'desktopwork', '.openclaw');
  }
}

async function handleRequest(agent: Agent, req: Request, writeStream: StreamWriter): Promise<Response> {
  switch (req.method) {
    case 'status': {
      const dataDir = resolveDataDir();
      const sessionsDir = join(dataDir, 'sessions');
      let sessionCount = 0;
      if (existsSync(sessionsDir)) {
        sessionCount = readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl')).length;
      }

      const { getCachedSkills } = await import('./skills.js');
      const skills = getCachedSkills();

      const result: StatusResult = {
        ok: true,
        version: VERSION,
        memoryReady: true,
        skillsLoaded: skills.length,
        sessionCount
      };

      return {
        jsonrpc: "2.0",
        id: req.id,
        result
      };
    }

    case 'ping': {
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: { pong: true }
      };
    }

    case 'shutdown': {
      console.error('[desktop-agent] Shutdown requested');
      await agent.shutdown();
      process.exit(0);
    }

    case 'reload': {
      const dataDir = resolveDataDir();
      const skillsDir = join(dataDir, 'skills');
      try {
        const { skills } = await reloadSkills([skillsDir]);
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            ok: true,
            skillsLoaded: skills.length
          }
        };
      } catch (e: any) {
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32603, message: e.message || String(e) }
        };
      }
    }

    case 'chat': {
      const params = req.params as ChatParams;
      if (!params?.message || !params?.sessionKey) {
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32602, message: "Invalid params: message and sessionKey required" }
        };
      }

      try {
        const onDelta = (delta: string) => {
          writeStream({
            jsonrpc: "2.0",
            id: req.id,
            method: "stream",
            params: { delta, done: false }
          });
        };

        const result = await agent.chat(params.message, params.sessionKey, onDelta);

        // Send final accumulated text as delta before done, then done: true
        if (result.text) {
          writeStream({
            jsonrpc: "2.0",
            id: req.id,
            method: "stream",
            params: { delta: result.text, done: false }
          });
        }
        writeStream({
          jsonrpc: "2.0",
          id: req.id,
          method: "stream",
          params: { done: true }
        });

        return {
          jsonrpc: "2.0",
          id: req.id,
          result: {
            text: result.text,
            sessionKey: params.sessionKey
          }
        };
      } catch (e: any) {
        // Emit stream error
        writeStream({
          jsonrpc: "2.0",
          id: req.id,
          method: "stream",
          params: { error: e.message || String(e), done: true }
        });

        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32603, message: e.message || String(e) }
        };
      }
    }

    default: {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `Method not found: ${req.method}` }
      };
    }
  }
}

async function main() {
  console.error(`[desktop-agent] v${VERSION} starting...`);

  const dataDir = resolveDataDir();

  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Create data directories
  const sessionsDir = join(dataDir, 'sessions');
  const memoryDir = join(dataDir, 'memory');
  const skillsDir = join(dataDir, 'skills');

  [sessionsDir, memoryDir, skillsDir].forEach(dir => {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  });

  console.error(`[desktop-agent] Data dir: ${dataDir}`);

  // Load skills on startup
  const { skills, diagnostics } = await loadUserSkills([skillsDir]);
  console.error(`[desktop-agent] Loaded ${skills.length} skills, ${diagnostics.length} diagnostics`);

  // Create agent
  const agent = await createAgent({
    dataDir,
    skillsDirs: [skillsDir]
  });

  console.error('[desktop-agent] Agent initialized');

  // Start IPC loop
  await startIpcLoop((req, writeStream) => handleRequest(agent, req, writeStream));
}

main().catch((e) => {
  console.error('[desktop-agent] Fatal:', e);
  process.exit(1);
});