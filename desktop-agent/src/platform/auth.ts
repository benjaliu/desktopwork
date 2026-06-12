// src/platform/auth.ts
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const AUTH_SECRET = process.env.DESKTOPWORK_AUTH_SECRET || 'dev-secret-change-in-prod';
const TOKEN_HEADER = 'x-desktop-work-token';

interface AuthToken {
  random: string;
  hmac: string;
  issuedAt: number;
}

export function generateToken(): string {
  const random = randomBytes(32).toString('hex');
  const hmac = createHmac('sha256', AUTH_SECRET).update(random).digest('hex');
  const payload: AuthToken = { random, hmac, issuedAt: Date.now() };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function verifyToken(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64url').toString()) as AuthToken;
    const expected = createHmac('sha256', AUTH_SECRET).update(payload.random).digest('hex');
    const actual = Buffer.from(payload.hmac, 'hex');
    const exp = Buffer.from(expected, 'hex');
    if (actual.length !== exp.length) return false;
    return timingSafeEqual(actual, exp);
  } catch {
    return false;
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/api/platform/health') return next();
  if (req.path === '/auth/login') return next();

  const token = req.headers[TOKEN_HEADER] as string;
  if (!token || !verifyToken(token)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}