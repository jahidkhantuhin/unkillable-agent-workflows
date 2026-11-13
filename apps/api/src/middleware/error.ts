import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../errors';
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const validation = error instanceof ZodError;
  if (error instanceof HttpError) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(error.status).json({
      error: { code: error.code, message: error.message, requestId: req.id },
    });
    return;
  }
  const malformed =
    error instanceof SyntaxError && 'status' in error && error.status === 400;
  if (!validation && !malformed)
    req.log.error({ err: error }, 'Request failed');
  // Parser errors can contain the raw request body, including a password.
  else
    req.log.warn(
      { code: validation ? 'VALIDATION_ERROR' : 'INVALID_JSON' },
      'Invalid request',
    );
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
