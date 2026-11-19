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
import { useToast } from './toast-provider';
type TicketDraft = Omit<TicketInput, 'amountCents'> & { amountCents: string };
function inputFrom(example: TicketInput): TicketDraft {
  return {
    title: example.title,
    description: example.description,
    customerEmail: example.customerEmail,
    orderId: example.orderId,
    amountCents: String(example.amountCents),
    currency: 'USD',
    customerTier: example.customerTier ?? 'standard',
  };
}
export function NewTicket() {
  const toast = useToast();
  const [ticket, setTicket] = useState<TicketDraft>(() =>
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
      if (!ticket.amountCents.trim()) throw new Error('Enter a charge amount.');
      const input = ticketInputSchema.parse({
        ...ticket,
        amountCents: Number(ticket.amountCents),
      });
      const response = await fetch('/api/backend/tickets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error?.message ?? 'Unable to create ticket');
      const run = runDTOSchema.parse(body);
      toast.success('Support ticket created and queued.');
      router.push(`/runs/${run.id}`);
    } catch (error) {
      toast.error(error, 'Unable to create ticket');
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
        Mailpit. The active approval policy chooses automatic replies, one
        review, or two reviews. Refunds always require human approval.
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
            if (example) {
              setTicket(inputFrom(example));
              toast.success(`Example loaded: ${example.title}`);
            }
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
          Synthetic customer tier
          <select
            className={field}
            value={ticket.customerTier ?? 'standard'}
            onChange={(event) =>
              setTicket({
                ...ticket,
                customerTier: event.target.value as 'standard' | 'vip',
              })
            }
          >
            <option value="standard">Standard</option>
            <option value="vip">VIP</option>
          </select>
        </label>
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
                  amountCents: event.target.value,
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
