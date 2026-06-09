import { loadSkills } from '../vendor/bundles/agent-core.esm.js';

interface SkillDiagnostic {
  type: string;
  message: string;
}

interface Skill {
  name: string;
  description: string;
}

interface LoadSkillsResult {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
}

// Node.js fs abstraction matching agent-core expectations
const nodeFs = {
  async readTextFile(path: string): Promise<{ ok: true; value: string } | { ok: false; error: { code: string; message: string } }> {
    try {
      const { readFileSync } = require('node:fs');
      return { ok: true, value: readFileSync(path, 'utf-8') };
    } catch (e: any) {
      if (e.code === 'ENOENT') return { ok: false, error: { code: 'not_found', message: e.message } };
      return { ok: false, error: { code: 'read_error', message: e.message } };
    }
  },

  async readDir(path: string): Promise<{ ok: true; value: string[] } | { ok: false; error: { code: string; message: string } }> {
    try {
      const { readdirSync } = require('node:fs');
      return { ok: true, value: readdirSync(path) };
    } catch (e: any) {
      return { ok: false, error: { code: 'read_dir_error', message: e.message } };
    }
  },

  async absolutePath(p: string): Promise<{ ok: true; value: string } | { ok: false; error: { code: string; message: string } }> {
    return { ok: true, value: p };
  },

  async joinPath(parts: string[]): Promise<{ ok: true; value: string } | { ok: false; error: { code: string; message: string } }> {
    return { ok: true, value: require('node:path').join(...parts) };
  },

  async fileInfo(p: string): Promise<{ ok: true; value: { isFile: boolean; isDir: boolean; size: number; mtimeMs: number } } | { ok: false; error: { code: string; message: string } }> {
    try {
      const { statSync } = require('node:fs');
      const s = statSync(p);
      return { ok: true, value: { isFile: s.isFile(), isDir: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs } };
    } catch (e: any) {
      if (e.code === 'ENOENT') return { ok: false, error: { code: 'not_found', message: e.message } };
      return { ok: false, error: { code: 'file_info_error', message: e.message } };
    }
  }
};

let cachedSkills: Skill[] = [];
let cachedDiagnostics: SkillDiagnostic[] = [];

export async function loadUserSkills(skillsDirs: string[]): Promise<LoadSkillsResult> {
  if (skillsDirs.length === 0) {
    return { skills: [], diagnostics: [] };
  }

  try {
    const result = await loadSkills(nodeFs as any, skillsDirs);
    cachedSkills = (result.skills || []).map((s: any) => ({
      name: s.name || '',
      description: s.description || ''
    }));
    cachedDiagnostics = result.diagnostics || [];
    return { skills: cachedSkills, diagnostics: cachedDiagnostics };
  } catch (e: any) {
    console.error('[skills] Failed to load skills:', e.message);
    return { skills: [], diagnostics: [{ type: 'error', message: e.message }] };
  }
}

export async function reloadSkills(skillsDirs: string[]): Promise<LoadSkillsResult> {
  return loadUserSkills(skillsDirs);
}

export function getCachedSkills(): Skill[] {
  return cachedSkills;
}