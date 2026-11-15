import { z } from 'zod';
export const workflowGraphSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
  nodes: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.enum(['task', 'approval', 'effect']),
    }),
  ),
  edges: z.array(z.object({ source: z.string(), target: z.string() })),
});
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;
