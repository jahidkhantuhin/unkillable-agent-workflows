import { healthSchema } from '@unkillable/shared';
export type HealthDependencies = {
  mongo: () => Promise<unknown>;
  redis: () => Promise<unknown>;
};
export async function getHealth(deps: HealthDependencies) {
  const results = await Promise.allSettled([deps.mongo(), deps.redis()]);
  return healthSchema.parse({
    status: results.every((result) => result.status === 'fulfilled')
      ? 'ok'
      : 'degraded',
    services: {
      mongo: results[0].status === 'fulfilled',
      redis: results[1].status === 'fulfilled',
    },
  });
}
