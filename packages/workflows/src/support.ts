import {
  classificationSchema,
  draftReplySchema,
  policySchema,
  localPolicies,
  PermanentError,
  type TicketInput,
  type Classification,
  type SupportPolicy,
  type DraftReply,
  type SupportMail,
} from '@unkillable/shared';
export interface LLM {
  classify(ticket: TicketInput): Promise<unknown>;
  draft(ticket: TicketInput, policies: SupportPolicy[]): Promise<unknown>;
}
export interface Retriever {
  retrieve(
    ticket: TicketInput,
    classification: Classification,
  ): Promise<SupportPolicy[]>;
}
export interface PaymentsClient {
  refund(
    runId: string,
    ticketId: string,
    amountCents: number,
  ): Promise<{ id: string; amountCents: number; currency: 'USD' }>;
}
export interface Mailer {
  send(
    runId: string,
    ticketId: string,
    mail: Omit<SupportMail, 'messageId'>,
  ): Promise<{ id: string; messageId: string }>;
}
export interface TicketStore {
  close(
    ticketId: string,
    status: 'closed' | 'rejected',
    runId?: string,
  ): Promise<void>;
}
export type SupportDependencies = {
  llm: LLM;
  retriever: Retriever;
  payments: PaymentsClient;
  mailer: Mailer;
  tickets: TicketStore;
};
export class MockLLM implements LLM {
  async classify(ticket: TicketInput) {
    const text = `${ticket.title} ${ticket.description}`.toLowerCase();
    const label = /duplicate|charged twice|double charge/.test(text)
      ? 'duplicate_charge'
      : /refund/.test(text)
        ? 'refund_request'
        : /invoice|how (do|can|to)/.test(text)
          ? 'how_to'
          : 'other';
    return classificationSchema.parse({
      label,
      confidence: 0.98,
      reason: 'Deterministic mock classification of this synthetic ticket.',
    });
  }
  async draft(ticket: TicketInput, policies: SupportPolicy[]) {
    const policy = policies[0];
    if (!policy) throw new PermanentError('No policy available for reply');
    return draftReplySchema.parse({
      message: policy.allowRefund
        ? `We reviewed your duplicate charge for ${ticket.orderId}. Subject to human approval, we will refund USD ${(ticket.amountCents / 100).toFixed(2)} to our local fake payment ledger.`
        : policy.id === 'account-help'
          ? 'You can download your invoice from Account > Billing > Invoices. Please contact support if you need more help.'
          : `Thank you for contacting support about ${ticket.orderId}. Your request needs manual eligibility review; no automatic refund has been issued.`,
      citedPolicyId: policy.id,
      citedSnippet: policy.text,
    });
  }
}
export class LocalPolicyRetriever implements Retriever {
  async retrieve(_ticket: TicketInput, classification: Classification) {
    const id =
      classification.label === 'duplicate_charge'
        ? 'duplicate-charge'
        : classification.label === 'how_to'
          ? 'account-help'
          : 'refund-review';
    return localPolicies
      .filter((policy) => policy.id === id)
      .map((policy) => policySchema.parse(policy));
  }
}
export async function classifyTicket(llm: LLM, ticket: TicketInput) {
  return classificationSchema.parse(await llm.classify(ticket));
}
export async function draftTicket(
  llm: LLM,
  ticket: TicketInput,
  policies: SupportPolicy[],
): Promise<DraftReply> {
  const draft = draftReplySchema.parse(await llm.draft(ticket, policies));
  if (
    !policies.some(
      (policy) =>
        policy.id === draft.citedPolicyId &&
        policy.text.includes(draft.citedSnippet),
    )
  )
    throw new PermanentError('Draft citation does not match retrieved policy');
  return draft;
}
