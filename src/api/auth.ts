// API key authentication middleware
//
// Reads API_KEY from environment variable. When set, all /api/* routes
// require the key in the X-API-Key header or ?apiKey query parameter.
// When API_KEY is not set, auth is disabled (development mode).

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

const API_KEY = process.env.API_KEY || '';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth if no API key is configured
  if (!API_KEY) {
    next();
    return;
  }

  // Allow health check without auth
  if (req.path === '/api/health') {
    next();
    return;
  }

  // Allow Swagger docs without auth
  if (req.path.startsWith('/api-docs')) {
    next();
    return;
  }

  // Check header first, then query parameter
  const provided = (req.headers['x-api-key'] as string) || (req.query.apiKey as string);

  if (!provided) {
    res.status(401).json({ error: 'Authentication required. Provide X-API-Key header.' });
    return;
  }

  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(provided, API_KEY)) {
    res.status(403).json({ error: 'Invalid API key' });
    return;
  }

  next();
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do the comparison to maintain constant time
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(a));
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// GET /api/auth/check — verify if auth is required and if key is valid
export function createAuthCheckRoute() {
  return (req: Request, res: Response) => {
    if (!API_KEY) {
      res.json({ required: false, authenticated: true });
      return;
    }
    const provided = (req.headers['x-api-key'] as string) || (req.query.apiKey as string);
    if (!provided) {
      res.json({ required: true, authenticated: false });
      return;
    }
    const valid = timingSafeEqual(provided, API_KEY);
    res.json({ required: true, authenticated: valid });
  };
}
