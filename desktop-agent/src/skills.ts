import { Router } from 'express';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const router = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));

let skillsCache: any[] = [];
let skillsLoaded = false;

async function loadSkills(): Promise<any[]> {
  if (skillsLoaded) return skillsCache;
  try {
    const { loadSkills } = await import(`../vendor/bundles/agent-core.esm.js`);
    const skillsDir = join(process.env.HOME || '', '.config', 'desktopwork', 'skills');
    const env = {
      readFile: readFile,
      readDir: async (dir: string) => {
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          return entries.map((e) => ({ name: e.name, isDirectory: () => e.isDirectory() }));
        } catch {
          return [];
        }
      },
    };
    const { skills } = await loadSkills(env, [skillsDir]);
    skillsCache = skills || [];
    skillsLoaded = true;
    return skillsCache;
  } catch (e) {
    console.error('Failed to load skills:', e);
    return [];
  }
}

// GET /skills
router.get('/', async (_req, res) => {
  const skills = await loadSkills();
  return res.json({ skills });
});

// POST /skills/:id/enable
router.post('/:id/enable', async (req, res) => {
  const skills = await loadSkills();
  const skill = skills.find((s: any) => s.id === req.params.id);
  if (!skill) return res.status(404).json({ error: 'skill not found' });
  skill.enabled = true;
  return res.json({ ok: true, skill });
});

// POST /skills/:id/disable
router.post('/:id/disable', async (req, res) => {
  const skills = await loadSkills();
  const skill = skills.find((s: any) => s.id === req.params.id);
  if (!skill) return res.status(404).json({ error: 'skill not found' });
  skill.enabled = false;
  return res.json({ ok: true, skill });
});

export default router;