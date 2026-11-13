import type { RequestHandler } from 'express';
import type { z } from 'zod';
export const validate =
  (
    schema: z.ZodType,
    target: 'body' | 'query' | 'params' = 'body',
  ): RequestHandler =>
  (req, res, next) => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      next(result.error);
      return;
    }
    res.locals[target] = result.data;
    next();
  };
