import { z } from 'zod';
import { infrastructureSchema } from '@unkillable/shared';
export const configSchema = infrastructureSchema.extend({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\//),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) =>
      value.split(',').map((origin) => z.url().parse(origin.trim())),
    ),
});
