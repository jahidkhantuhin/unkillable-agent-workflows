import Link from 'next/link';
import { ArrowRight, Check, GitBranch } from 'lucide-react';
import { Button } from '@/components/ui/button';
export default function Home() {
  return (
    <>
      <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        STEP 04 / RELIABILITY LAYER
      </div>
      <h1 className="max-w-3xl text-5xl font-semibold leading-[1.08] tracking-tight md:text-7xl">
        Agents that act.
        <br />
        <span className="text-muted-foreground">Workflows that last.</span>
      </h1>
      <p className="mt-7 max-w-xl text-lg leading-relaxed text-muted-foreground">
        Human control meets durable execution. A workspace for agents that pause
        for approval, recover from crashes, and leave a trail you can trust.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild>
          <Link href="/runs">
            Open workspace
            <ArrowRight className="size-4" />
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/workflows">Explore workflows</Link>
        </Button>
      </div>
      <section className="mt-16 rounded-2xl border border-border bg-muted/30 p-7">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">The reliability path</h2>
          <GitBranch className="size-5 text-muted-foreground" />
        </div>
        <div className="mt-7 grid gap-4 md:grid-cols-3">
          {[
            'Take an action',
            'Pause for a human',
            'Resume with confidence',
          ].map((title, i) => (
            <div
              key={title}
              className="rounded-xl border border-border bg-background p-5"
            >
              <span className="font-mono text-xs text-emerald-500">
                0{i + 1}
              </span>
              <h3 className="mt-4 font-medium">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {
                  [
                    'Typed workflows and isolated side effects.',
                    'Risky decisions stay in your hands.',
                    'Checkpoints preserve the work that matters.',
                  ][i]
                }
              </p>
            </div>
          ))}
        </div>
        <p className="mt-5 text-xs text-muted-foreground">
          Platform roadmap preview · Approvals arrive in a later step.
        </p>
      </section>
      <section className="mt-10 grid gap-8 md:grid-cols-2">
        <div>
          <p className="text-xs tracking-widest text-muted-foreground">
            DESIGNED TO PROVE
          </p>
          <div className="mt-4 space-y-3">
            {[
              'Survive worker and API restarts',
              'Prevent duplicate side effects',
              'Keep humans in control',
              'Inspect every state change',
              'Measure recovery with chaos tests',
            ].map((goal) => (
              <p key={goal} className="flex items-center gap-3 text-sm">
                <Check className="size-4 text-emerald-500" />
                {goal}
              </p>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-border p-6">
          <p className="text-xs tracking-widest text-muted-foreground">
            CURRENT BUILD
          </p>
          <h2 className="mt-3 text-xl font-medium">
            Your first durable workflow is ready.
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Sign in, start the deterministic demo, and follow each checkpoint on
            its live timeline. Completed work survives worker restarts.
          </p>
        </div>
      </section>
    </>
  );
}
