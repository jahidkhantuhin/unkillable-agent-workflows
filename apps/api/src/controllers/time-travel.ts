import type { RequestHandler } from 'express';
import { runToDTO } from '@unkillable/shared';
import type { TimeTravelService } from '../services/time-travel';
export function listCheckpoints(service: TimeTravelService): RequestHandler {
  return async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(
      await service.history(
        res.locals.params.id,
        res.locals.query.limit,
        res.locals.query.before,
      ),
    );
  };
}
export function getCheckpoint(service: TimeTravelService): RequestHandler {
  return async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(
      await service.checkpoint(
        res.locals.params.id,
        res.locals.params.checkpointId,
      ),
    );
  };
}
export function getStateDiff(service: TimeTravelService): RequestHandler {
  return async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(
      await service.diff(
        res.locals.params.id,
        res.locals.query.from,
        res.locals.query.to,
      ),
    );
  };
}
export function getForks(service: TimeTravelService): RequestHandler {
  return async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.relations(res.locals.params.id));
  };
}
export function forkRun(service: TimeTravelService): RequestHandler {
  return async (_req, res) => {
    res
      .status(202)
      .json(
        runToDTO(
          await service.fork(
            res.locals.params.id,
            res.locals.body.checkpointId,
            res.locals.body.edits,
            res.locals.identity,
          ),
        ),
      );
  };
}
