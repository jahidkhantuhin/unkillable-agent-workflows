import type { RequestHandler, Response } from 'express';
import { setTimeout as delay } from 'node:timers/promises';
import { fromNodeHeaders } from 'better-auth/node';
import {
  runToDTO,
  terminalStatuses,
  eventCursorSchema,
  type Identity,
} from '@unkillable/shared';
import type { RunService } from '../services/runs';
import type { AuthService } from '../services/auth';
import { HttpError } from '../errors';
const streams = new Set<Response>();
export function closeRunStreams() {
  for (const response of streams) response.end();
}
export function createRun(service: RunService): RequestHandler {
  return async (_req, res) => {
    const identity = res.locals.identity as Identity;
    const run = await service.create(identity.user.id, res.locals.body.input);
    res.status(202).json(runToDTO(run));
  };
}
export function listRuns(service: RunService): RequestHandler {
  return async (_req, res) => {
    const { limit, status } = res.locals.query;
    res.setHeader('Cache-Control', 'no-store');
    res.json((await service.list(limit, status)).map(runToDTO));
  };
}
export function getRun(service: RunService): RequestHandler {
  return async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(runToDTO(await service.get(res.locals.params.id)));
  };
}
export function getReliability(service: RunService): RequestHandler {
  return async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.details(res.locals.params.id));
  };
}
async function write(response: Response, frame: string) {
  if (response.destroyed || response.writableEnded) return;
  if (response.write(frame)) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      response.off('drain', done);
      response.off('close', done);
      resolve();
    };
    response.once('drain', done);
    response.once('close', done);
  });
}
export function streamRun(
  service: RunService,
  auth: AuthService,
): RequestHandler {
  return async (req, res) => {
    const id = res.locals.params.id as string;
    let run = await service.get(id);
    let cursor = eventCursorSchema.parse(
      req.headers['last-event-id'] ?? req.query.after ?? 0,
    );
    if (cursor > run.sequence)
      throw new HttpError(
        400,
        'INVALID_CURSOR',
        'The cursor is ahead of this run',
      );
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once('close', close);
    streams.add(res);
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    let heartbeat = Date.now();
    try {
      await write(res, 'retry: 2000\n\n');
      while (!controller.signal.aborted) {
        if (Date.now() - heartbeat >= 15000) {
          await auth.me(fromNodeHeaders(req.headers));
          await write(res, ': heartbeat\n\n');
          heartbeat = Date.now();
        }
        const events = await service.repository.events(id, cursor);
        for (const event of events) {
          if (controller.signal.aborted) break;
          await write(
            res,
            `id: ${event.sequence}\nevent: run-event\ndata: ${JSON.stringify(event)}\n\n`,
          );
          cursor = event.sequence;
        }
        run = await service.get(id);
        if (
          terminalStatuses.includes(run.status) &&
          (await service.repository.pendingOutboxCount(id)) === 0
        ) {
          const latest = await service.get(id);
          if (cursor >= latest.sequence) {
            await write(res, 'event: stream-end\ndata: {}\n\n');
            break;
          }
        }
        if (events.length < 200)
          await delay(500, undefined, { signal: controller.signal });
      }
    } catch (error) {
      if (!controller.signal.aborted)
        req.log.warn({ err: error }, 'Run event stream closed');
    } finally {
      streams.delete(res);
      res.off('close', close);
      res.end();
    }
  };
}
