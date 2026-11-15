import { z } from 'zod';
export const kinds = [
  'normal',
  'worker_crash',
  'api_kill',
  'throw_once',
  'permanent',
  'delay',
  'duplicate',
  'compensation_crash',
] as const;
export type Kind = (typeof kinds)[number];
export const defaultRates: Record<Kind, number> = {
  normal: 0.35,
  worker_crash: 0.15,
  api_kill: 0.1,
  throw_once: 0.1,
  permanent: 0.1,
  delay: 0.1,
  duplicate: 0.05,
  compensation_crash: 0.05,
};
export const settingsSchema = z.object({
  runs: z.coerce.number().int().min(8).max(10000).default(500),
  seed: z.coerce.number().int().min(0).max(0xffffffff).default(20261116),
  batchSize: z.coerce.number().int().min(1).max(32).default(8),
  timeoutMs: z.coerce.number().int().min(10000).max(600000).default(120000),
  reportDir: z.string().default('docs'),
  keepData: z.boolean().default(false),
  rates: z
    .record(z.enum(kinds), z.number().min(0).max(1))
    .default(defaultRates)
    .refine(
      (rates) =>
        Math.abs(Object.values(rates).reduce((a, b) => a + b, 0) - 1) < 1e-8,
      'Fault rates must sum to one',
    ),
});
export type Settings = z.infer<typeof settingsSchema>;
export function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function schedule(config: Settings) {
  const rng = random(config.seed);
  const plan = Array.from({ length: config.runs }, () => {
    let draw = rng();
    for (const kind of kinds) {
      draw -= config.rates[kind];
      if (draw < 0) return kind;
    }
    return kinds[kinds.length - 1];
  });
  // Ensure every enabled fault is exercised, including the lightweight CI run.
  const enabled = kinds.filter((kind) => config.rates[kind] > 0);
  enabled.forEach((kind, index) => {
    plan[index] = kind;
  });
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }
  return plan.map((kind, index) => ({
    index,
    kind,
    delayMs: 20 + Math.floor(rng() * 81),
  }));
}
export type Plan = ReturnType<typeof schedule>[number];
export function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}
export function distribution(values: number[]) {
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
  };
}
