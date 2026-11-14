import type { RequestHandler } from 'express';
import type { DeadLetterService } from '../services/dead-letters';
export function listDeadLetters(service: DeadLetterService): RequestHandler {
  return async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.list());
  };
}
export function getDeadLetter(service: DeadLetterService): RequestHandler {
  return async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.get(res.locals.params.id));
  };
}
export function resolveDeadLetter(
  service: DeadLetterService,
  action: 'retry' | 'discard',
): RequestHandler {
  return async (_req, res) => {
    res.json(
      await service.resolve(
        res.locals.params.id,
        res.locals.body.version,
        action,
        res.locals.identity.user.id,
      ),
    );
  };
}
