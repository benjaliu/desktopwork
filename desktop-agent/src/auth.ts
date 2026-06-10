import { Router } from 'express';
import jwt from 'jsonwebtoken';

const router = Router();

// 临时固定密钥（后续替换为 OIDC）
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production-2026';

// Stub 用户表（任意密码都可通过）
const STUB_USERS: Record<string, { userId: string; name: string; role: string }> = {
  admin: { userId: 'u001', name: 'Admin', role: 'admin' },
  user: { userId: 'u002', name: 'User', role: 'user' },
};

// 内存中的 token -> user 映射
const tokenStore = new Map<string, string>(); // token -> username

function generateToken(username: string): string {
  const payload = { sub: username, userId: STUB_USERS[username]?.userId };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token: string): { sub: string; userId: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { sub: string; userId: string };
  } catch {
    return null;
  }
}

// POST /auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  if (!STUB_USERS[username]) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const token = generateToken(username);
  tokenStore.set(token, username);
  return res.json({
    token,
    user: STUB_USERS[username],
  });
});

// GET /auth/me
router.get('/me', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const token = auth.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
  const user = STUB_USERS[payload.sub];
  if (!user) {
    return res.status(401).json({ error: 'user not found' });
  }
  return res.json({ user });
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    tokenStore.delete(auth.slice(7));
  }
  return res.json({ ok: true });
});

// Express middleware: 验证 JWT
export function authMiddleware(req: any, res: any, next: any) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const payload = verifyToken(auth.slice(7));
  if (!payload) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
  req.user = { username: payload.sub, ...STUB_USERS[payload.sub] };
  next();
}

export default router;