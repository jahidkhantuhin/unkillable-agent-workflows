import type { RequestHandler } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { hasPermission, type Permission } from '@unkillable/shared';
import type { AuthService } from '../services/auth';
import { HttpError } from '../errors';
export function requireAuth(
  service: AuthService,
  permission?: Permission,
): RequestHandler {
  return async (req, res, next) => {
    const identity = await service.me(fromNodeHeaders(req.headers));
    if (permission && !hasPermission(identity.role, permission))
      throw new HttpError(
        403,
        'FORBIDDEN',
        'Your role does not allow this action',
      );
    res.locals.identity = identity;
    next();
  };
}
export function trustedOrigin(origins: readonly string[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.headers.origin || !origins.includes(req.headers.origin))
      throw new HttpError(
        403,
        'INVALID_ORIGIN',
        'A trusted Origin header is required',
      );
    next();
  };
}
