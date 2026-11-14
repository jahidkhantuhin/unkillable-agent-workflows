'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ticketInputSchema,
  ticketExampleSchema,
  supportExamples,
  runDTOSchema,
  type TicketInput,
} from '@unkillable/shared';
import { Button } from './ui/button';
function inputFrom(example: TicketInput): TicketInput {
  return {
    title: example.title,
    description: example.description,
    customerEmail: example.customerEmail,
    orderId: example.orderId,
    amountCents: example.amountCents,
    currency: 'USD',
  };
}
export function NewTicket() {
  const [ticket, setTicket] = useState<TicketInput>(() =>
    inputFrom(supportExamples[0]),
  );
  const [examples, setExamples] = useState<
    ReturnType<typeof ticketExampleSchema.parse>[]
  >(supportExamples.map((value) => ticketExampleSchema.parse(value)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/backend/tickets/examples', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.ok) {
          const body: unknown = await response.json();
          if (Array.isArray(body))
            setExamples(body.map((value) => ticketExampleSchema.parse(value)));
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const input = ticketInputSchema.parse(ticket);
      const response = await fetch('/api/backend/tickets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error?.message ?? 'Unable to create ticket');
      router.push(`/runs/${runDTOSchema.parse(body).id}`);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Unable to create ticket',
      );
    } finally {
      setBusy(false);
    }
  }
  const field =
    'mt-2 w-full rounded-lg border border-border bg-background p-3 text-sm';
  return (
    <>
      <Link href="/runs" className="text-sm text-muted-foreground">
        ← All runs
      </Link>
      <p className="mt-6 text-xs tracking-widest text-emerald-500">
        SUPPORT WORKFLOW
      </p>
      <h1 className="mt-3 text-4xl font-semibold">New ticket</h1>
      <p className="mt-3 max-w-3xl text-sm text-muted-foreground">
        Synthetic tickets only. Refunds use a fake ledger; replies go to local
        Mailpit. Every ticket pauses for human approval before either action.
      </p>
      <label className="mt-8 block text-sm">
        Load an example
        <select
          className={field}
          defaultValue="duplicate-charge"
          onChange={(event) => {
            const example = examples.find(
              (item) => item.id === event.target.value,
            );
            if (example) setTicket(inputFrom(example));
          }}
        >
          {examples.map((example) => (
            <option key={example.id} value={example.id}>
              {example.title}
            </option>
          ))}
        </select>
      </label>
      <form
        onSubmit={submit}
        className="mt-6 space-y-5 rounded-2xl border border-border p-6"
      >
        <label className="block text-sm">
          Ticket title
          <input
            required
            maxLength={200}
            value={ticket.title}
            onChange={(event) =>
              setTicket({ ...ticket, title: event.target.value })
            }
            className={field}
          />
        </label>
        <label className="block text-sm">
          Ticket description
          <textarea
            required
            maxLength={4000}
            rows={5}
            value={ticket.description}
            onChange={(event) =>
              setTicket({ ...ticket, description: event.target.value })
            }
            className={field}
          />
        </label>
        <div className="grid gap-5 md:grid-cols-3">
          <label className="block text-sm">
            Synthetic customer email (.test)
            <input
              type="email"
              required
              value={ticket.customerEmail}
              onChange={(event) =>
                setTicket({ ...ticket, customerEmail: event.target.value })
              }
              className={field}
            />
          </label>
          <label className="block text-sm">
            Demo order ID
            <input
              required
              maxLength={80}
              value={ticket.orderId}
              onChange={(event) =>
                setTicket({ ...ticket, orderId: event.target.value })
              }
              className={field}
            />
          </label>
          <label className="block text-sm">
            Charge amount (USD cents)
            <input
              type="number"
              required
              min={0}
              max={100000}
              step={1}
              value={ticket.amountCents}
              onChange={(event) =>
                setTicket({
                  ...ticket,
                  amountCents: Number(event.target.value),
                })
              }
              className={field}
            />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          For example, 4900 means USD 49.00. The local policy and classification
          determine refund eligibility; a human must approve it.
        </p>
        {error && (
          <p role="alert" className="text-sm text-red-500">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button disabled={busy} type="submit">
            {busy ? 'Queueing…' : 'Start support workflow'}
          </Button>
        </div>
      </form>
    </>
  );
}
