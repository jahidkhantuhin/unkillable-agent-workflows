import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const validation = error instanceof ZodError;
  const malformed =
    error instanceof SyntaxError && 'status' in error && error.status === 400;
  req.log.error({ err: error }, 'Request failed');
  res.status(validation || malformed ? 400 : 500).json({
    error: {
      code: validation
        ? 'VALIDATION_ERROR'
        : malformed
          ? 'INVALID_JSON'
          : 'INTERNAL_ERROR',
      message: validation
        ? 'Invalid request'
        : malformed
          ? 'Malformed JSON'
          : 'Internal server error',
      requestId: req.id,
      ...(validation ? { issues: error.issues } : {}),
    },
  });
};
