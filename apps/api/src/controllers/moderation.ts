import type { RequestHandler } from 'express';
import { pipeline } from 'node:stream/promises';
import { runToDTO, maxContentBytes } from '@unkillable/shared';
import { ContentUploadError } from '@unkillable/storage';
import { HttpError } from '../errors';
import type { ModerationService } from '../services/moderation';
export function uploadContent(service: ModerationService): RequestHandler {
  return async (req, res) => {
    if (!req.is('text/plain'))
      throw new HttpError(
        415,
        'TEXT_REQUIRED',
        'Upload UTF-8 text with Content-Type text/plain',
      );
    if (Number(req.headers['content-length'] ?? 0) > maxContentBytes)
      throw new HttpError(
        413,
        'CONTENT_TOO_LARGE',
        'Text uploads must not exceed 10 MiB',
      );
    try {
      res
        .status(202)
        .json(
          runToDTO(
            await service.upload(
              req,
              res.locals.query.title,
              res.locals.identity.user.id,
            ),
          ),
        );
    } catch (error) {
      if (error instanceof ContentUploadError)
        throw new HttpError(error.status, 'INVALID_CONTENT', error.message);
      throw error;
    }
  };
}
export function listContent(service: ModerationService): RequestHandler {
  return async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.list());
  };
}
export function downloadContent(service: ModerationService): RequestHandler {
  return async (_req, res) => {
    const stream = await service.content(res.locals.params.id);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="moderation-content.txt"',
    );
    res.setHeader('Cache-Control', 'no-store');
    await pipeline(stream, res);
  };
}
