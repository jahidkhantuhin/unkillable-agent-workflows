const scenarios = {
  normal: {
    title: 'Healthy delivery',
    color:
      'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  },
  'retry-once': {
    title: 'Transient failure, then recover',
    color: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400',
  },
  exhaust: {
    title: 'Exhaust retries; recover on manual retry',
    color:
      'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-400',
  },
  permanent: {
    title: 'Permanent failure; discard example',
    color: 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400',
  },
};
export function RunScenario({ state }: { state: unknown }) {
  if (
    state &&
    typeof state === 'object' &&
    'kind' in state &&
    state.kind === 'support-ticket'
  )
    return (
      <span className="inline-flex rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-700 dark:text-sky-400">
        Support ticket
      </span>
    );
  const mode =
    state && typeof state === 'object' && 'deliveryMode' in state
      ? state.deliveryMode
      : 'normal';
  const scenario =
    typeof mode === 'string' && Object.hasOwn(scenarios, mode)
      ? scenarios[mode as keyof typeof scenarios]
      : scenarios.normal;
  return (
    <span
      className={`inline-flex rounded-lg border px-3 py-1 text-xs font-medium ${scenario.color}`}
    >
      {scenario.title}
    </span>
  );
}
export function runTitle(state: unknown) {
  if (
    state &&
    typeof state === 'object' &&
    'title' in state &&
    typeof state.title === 'string' &&
    state.title.trim()
  )
    return state.title;
  return state &&
    typeof state === 'object' &&
    'message' in state &&
    typeof state.message === 'string'
    ? state.message
    : '';
}
