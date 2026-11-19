import type { RequestHandler, Request, Response } from 'express';
import { InvalidApprovalLink } from '../services/approval-signing';
import { NotificationConflict } from '@unkillable/storage';
import { HttpError } from '../errors';
import type { Reviewer } from '../services/notifications';
export function reviewer(res: Response): Reviewer {
  return { id: res.locals.identity.user.id, role: res.locals.identity.role };
}
export function notificationAction(
  action: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json(await action(req, res));
    } catch (error) {
      if (error instanceof InvalidApprovalLink)
        throw new HttpError(400, 'INVALID_APPROVAL_LINK', error.message);
      if (error instanceof NotificationConflict)
        throw new HttpError(409, 'APPROVAL_LINK_CONFLICT', error.message);
      throw error;
    }
  };
}
