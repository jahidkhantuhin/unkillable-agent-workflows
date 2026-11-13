import { z } from 'zod';
import { idSchema, roleSchema, workspaceId } from './domain';
const emailSchema = z
  .email()
  .max(254)
  .transform((email) => email.toLowerCase());
export const loginSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export const registerSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  email: emailSchema,
  password: z.string().min(12).max(128),
});
export const publicUserSchema = z.object({
  id: idSchema,
  name: z.string(),
  email: z.email(),
});
export const identitySchema = z.object({
  user: publicUserSchema,
  role: roleSchema,
  workspaceId: z.literal(workspaceId),
});
export type Identity = z.infer<typeof identitySchema>;
