// src/ai/startup-warmer.ts
import { startup, type WarmQuery } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync } from 'node:fs';
import { loadConfig } from '../platform/config.js';
import type { DesktopWorkConfig } from '../platform/types.js';
import { buildEnv, PLATFORM_CWD } from './agent-service.js';

let warm: WarmQuery | null = null;

/**
 * Prewarm the subprocess (called once at startup, failure doesn't throw).
 */
export async function prewarmClaude(_cfg: DesktopWorkConfig): Promise<void> {
  if (warm) return; // Idempotent

  try {
    // ★ SDK subprocess 要求 cwd 已存在（否则 "exists but failed to launch"）
    mkdirSync(PLATFORM_CWD, { recursive: true });

    // 重新读最新 config（hot-update）以拿到最新的 token/baseUrl
    const cfg = await loadConfig();

    warm = await startup({
      options: {
        cwd: PLATFORM_CWD,
        env: buildEnv(cfg),
      },
      initializeTimeoutMs: 30_000,
    });
    console.log('[claude] subprocess prewarmed');
  } catch (e: any) {
    console.error('[claude] prewarm failed:', e.message);
    // Don't throw — failure doesn't affect Platform startup
  }
}

/**
 * Get the warm query (used in AgentService.stream).
 * Returns null if prewarm failed or hasn't completed.
 */
export function getWarmQuery(): WarmQuery | null {
  return warm;
}

/**
 * Invalidate the warm query (called on config change).
 * Closes the old subprocess; next query() will re-startup automatically.
 */
export async function invalidateWarmQuery(): Promise<void> {
  if (warm) {
    try {
      await warm.close();
    } catch (e) {
      // Ignore
    }
    warm = null;
  }
}