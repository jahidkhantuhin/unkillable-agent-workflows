import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  supportStateSchema,
  supportExamples,
  ticketInputSchema,
  supportConfigSchema,
  localPolicies,
  classificationSchema,
} from '@unkillable/shared';
import {
  MockLLM,
  LocalPolicyRetriever,
  classifyTicket,
  draftTicket,
  type SupportDependencies,
} from './support';
import { supportNodeOutput } from './support-runtime';
import { createLLM, OrgMindRetriever } from './support-providers';
function ticket(index = 0) {
  const example = supportExamples[index]!;
  return ticketInputSchema.parse({
    title: example.title,
    description: example.description,
    customerEmail: example.customerEmail,
    orderId: example.orderId,
    amountCents: example.amountCents,
    currency: example.currency,
  });
}
describe('support ticket nodes', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    [0, 'duplicate_charge'],
    [1, 'refund_request'],
    [2, 'how_to'],
  ] as const)(
    'classifies example %s with grounded mock output',
    async (index, label) => {
      const llm = new MockLLM();
      const input = ticket(index);
      const classification = await classifyTicket(llm, input);
      expect(classification.label).toBe(label);
      const policies = await new LocalPolicyRetriever().retrieve(
        input,
        classification,
      );
      const draft = await draftTicket(llm, input, policies);
      expect(policies[0]?.text).toContain(draft.citedSnippet);
    },
  );
  it('rejects invalid structured classifications and invented citations', async () => {
    const input = ticket();
    const llm = new MockLLM();
    await expect(
      classifyTicket(
        {
          ...llm,
          classify: async () => ({
            label: 'duplicate_charge',
            confidence: 2,
            reason: 'bad',
          }),
          draft: llm.draft,
        },
        input,
      ),
    ).rejects.toThrow();
    await expect(
      draftTicket(
        {
          classify: llm.classify,
          draft: async () => ({
            message: 'Hello',
            citedPolicyId: 'invented',
            citedSnippet: 'invented',
          }),
        },
        input,
        localPolicies,
      ),
    ).rejects.toThrow('citation');
  });
  it('bounds refunds by policy and blocks effects before a human decision', async () => {
    const input = ticket();
    const state = supportStateSchema.parse({
      title: input.title,
      message: input.description,
      ticketId: 'test-ticket',
      ticket: input,
      classification: {
        label: 'duplicate_charge',
        confidence: 0.98,
        reason: 'mock',
      },
      policies: [{ ...localPolicies[0], maxRefundCents: 100 }],
      draft: {
        message: 'Review',
        citedPolicyId: 'duplicate-charge',
        citedSnippet: localPolicies[0]!.text,
      },
    });
    const payments = { refund: vi.fn() };
    const mailer = { send: vi.fn() };
    const deps: SupportDependencies = {
      llm: new MockLLM(),
      retriever: new LocalPolicyRetriever(),
      payments,
      mailer,
      tickets: { close: vi.fn() },
    };
    expect(
      (await supportNodeOutput('risk_check', 'run', state, deps)).risk
        ?.refundCents,
    ).toBe(0);
    await expect(
      supportNodeOutput('issue_refund', 'run', state, deps),
    ).rejects.toThrow('human decision');
    await expect(
      supportNodeOutput('send_email', 'run', state, deps),
    ).rejects.toThrow('human decision');
    expect(payments.refund).not.toHaveBeenCalled();
    expect(mailer.send).not.toHaveBeenCalled();
    const eligible = {
      ...state,
      policies: [localPolicies[0]!],
      approvalAction: 'approve' as const,
    };
    expect(
      (await supportNodeOutput('risk_check', 'run', eligible, deps)).risk
        ?.refundCents,
    ).toBe(input.amountCents);
  });
  it('defaults to MockLLM without network calls and validates optional retriever responses', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const llm = createLLM(supportConfigSchema.parse({}));
    await classifyTicket(llm, ticket());
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ policies: [localPolicies[0]] }), {
        status: 200,
      }),
    );
    expect(
      await new OrgMindRetriever('http://localhost/retrieve', fetcher).retrieve(
        ticket(),
        classificationSchema.parse({
          label: 'duplicate_charge',
          confidence: 1,
          reason: 'mock',
        }),
      ),
    ).toHaveLength(1);
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    await expect(
      new OrgMindRetriever('http://localhost/retrieve', fetcher).retrieve(
        ticket(),
        { label: 'other', confidence: 1, reason: 'mock' },
      ),
    ).rejects.toMatchObject({ name: 'RetryableError' });
  });
  it('rejects real recipients, remote SMTP, and incomplete model configuration', () => {
    expect(
      ticketInputSchema.safeParse({
        ...ticket(),
        customerEmail: 'person@gmail.com',
      }).success,
    ).toBe(false);
    expect(
      supportConfigSchema.safeParse({ MAILPIT_SMTP_HOST: 'smtp.gmail.com' })
        .success,
    ).toBe(false);
    expect(
      supportConfigSchema.safeParse({ SUPPORT_LLM_PROVIDER: 'gemini' }).success,
    ).toBe(false);
    expect(
      supportConfigSchema.safeParse({ SUPPORT_LLM_PROVIDER: 'ollama' }).success,
    ).toBe(false);
  });
});
