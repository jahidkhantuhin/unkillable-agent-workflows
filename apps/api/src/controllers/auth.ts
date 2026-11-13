import type { RequestHandler } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import type { AuthService } from '../services/auth';
export function authController(
  service: AuthService,
  action: 'register' | 'login' | 'logout',
): RequestHandler {
  return async (req, res) => {
    const result = await service.authenticate(
      action,
      fromNodeHeaders(req.headers),
      res.locals.body ?? {},
    );
    if (result.cookies.length) res.setHeader('Set-Cookie', result.cookies);
    res.setHeader('Cache-Control', 'no-store');
    if (action === 'logout') {
      res.status(204).end();
      return;
    }
    res.status(action === 'register' ? 201 : 200).json(result.identity);
  };
}
export const meController: RequestHandler = (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(res.locals.identity);
};
