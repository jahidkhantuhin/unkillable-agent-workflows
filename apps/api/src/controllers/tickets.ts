import type { RequestHandler } from 'express';
import { runToDTO } from '@unkillable/shared';
import type { RunService } from '../services/runs';
export function createTicket(service: RunService): RequestHandler {
  return async (_req, res) => {
    res
      .status(202)
      .json(
        runToDTO(
          await service.createTicket(
            res.locals.identity.user.id,
            res.locals.body,
          ),
        ),
      );
  };
}
export function ticketExamples(service: RunService): RequestHandler {
  return async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.ticketExamples());
  };
}
