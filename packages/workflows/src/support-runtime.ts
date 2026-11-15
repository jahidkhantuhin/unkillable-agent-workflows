import {
  StateGraph,
  StateSchema,
  START,
  END,
  interrupt,
} from '@langchain/langgraph';
import { MongoClient } from 'mongodb-checkpoint-driver';
import {
  supportStateSchema,
  approvalDecisionSchema,
  policySchema,
  PermanentError,
  type SupportState,
  type SupportNode,
} from '@unkillable/shared';
import { ObservedSaver } from './runtime';
import {
  classifyTicket,
  draftTicket,
  type SupportDependencies,
} from './support';
export type SupportHooks = {
  approvalFinished?: (runId: string) => Promise<void>;
  stepStarted: (runId: string, node: SupportNode) => Promise<void>;
  checkpoint: (runId: string, state: SupportState, id: string) => Promise<void>;
  runNode: (
    runId: string,
    node: SupportNode,
    operation: () => Promise<Partial<SupportState>>,
  ) => Promise<Partial<SupportState>>;
};
export async function supportNodeOutput(
  name: Exclude<SupportNode, 'approval'>,
  runId: string,
  state: SupportState,
  deps: SupportDependencies,
): Promise<Partial<SupportState>> {
  if (
    ['issue_refund', 'send_email', 'close_ticket'].includes(name) &&
    !['approve', 'edit'].includes(state.approvalAction)
  )
    throw new PermanentError(
      'A human decision is required before support effects',
    );
  const completed = [...state.completed, name];
  switch (name) {
    case 'classify':
      return {
        classification: await classifyTicket(deps.llm, state.ticket),
        completed,
      };
    case 'retrieve_policy': {
      const policies = (
        await deps.retriever.retrieve(state.ticket, state.classification)
      ).map((policy) => policySchema.parse(policy));
      if (!policies.length) throw new PermanentError('No policy found');
      return { policies, completed };
    }
    case 'draft_reply':
      return {
        draft: await draftTicket(deps.llm, state.ticket, state.policies),
        completed,
      };
    case 'risk_check': {
      const cited = state.policies.find(
        (policy) => policy.id === state.draft.citedPolicyId,
      );
      const refundCents =
        state.classification.label === 'duplicate_charge' &&
        state.classification.confidence >= 0.8 &&
        cited?.allowRefund &&
        state.ticket.amountCents <= cited.maxRefundCents
          ? state.ticket.amountCents
          : 0;
      return {
        risk: {
          refundCents,
          currency: 'USD',
          reason: refundCents
            ? 'Human approval is required before this synthetic duplicate-charge refund and reply.'
            : 'No automatic refund is eligible. Human approval is required before sending the reply.',
        },
        completed,
      };
    }
    case 'issue_refund':
      return {
        refund: state.risk.refundCents
          ? await deps.payments.refund(
              runId,
              state.ticketId,
              state.risk.refundCents,
            )
          : { id: '', amountCents: 0, currency: 'USD' },
        completed,
      };
    case 'send_email':
      return {
        email: await deps.mailer.send(runId, state.ticketId, {
          to: state.ticket.customerEmail,
          subject: `Re: ${state.ticket.title.replace(/[\r\n]/g, ' ')}`,
          text: state.approvedMessage,
        }),
        completed,
      };
    case 'close_ticket':
      await deps.tickets.close(state.ticketId, 'closed', runId);
      return { ticketStatus: 'closed', completed };
  }
}
export async function createSupportRuntime(
  uri: string,
  dbName: string,
  hooks: SupportHooks,
  deps: SupportDependencies,
) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const saver = new ObservedSaver(client, dbName, hooks, supportStateSchema);
  const errors = await saver.setup();
  if (errors.length) {
    await client.close();
    throw new AggregateError(errors, 'Support checkpoint setup failed');
  }
  const node =
    (name: Exclude<SupportNode, 'approval'>) =>
    async (
      state: SupportState,
      config: { configurable?: Record<string, unknown> },
    ) => {
      const runId = String(config.configurable?.thread_id);
      await hooks.stepStarted(runId, name);
      return hooks.runNode(runId, name, () =>
        supportNodeOutput(name, runId, state, deps),
      );
    };
  const graph = new StateGraph(new StateSchema(supportStateSchema.shape))
    .addNode('classify', node('classify'), { retryPolicy: { maxAttempts: 1 } })
    .addNode('retrieve_policy', node('retrieve_policy'), {
      retryPolicy: { maxAttempts: 1 },
    })
    .addNode('draft_reply', node('draft_reply'), {
      retryPolicy: { maxAttempts: 1 },
    })
    .addNode('risk_check', node('risk_check'), {
      retryPolicy: { maxAttempts: 1 },
    })
    .addNode(
      'approval',
      async (
        state: SupportState,
        config: { configurable?: Record<string, unknown> },
      ) => {
        await hooks.stepStarted(
          String(config.configurable?.thread_id),
          'approval',
        );
        const decision = approvalDecisionSchema.parse(
          interrupt({
            message: state.draft.message,
            refundCents: state.risk.refundCents,
          }),
        );
        await hooks.approvalFinished?.(String(config.configurable?.thread_id));
        if (decision.action === 'reject')
          await deps.tickets.close(state.ticketId, 'rejected');
        return {
          approvalAction: decision.action,
          approvedMessage:
            decision.action === 'edit'
              ? decision.payload.message
              : state.draft.message,
          ticketStatus:
            decision.action === 'reject'
              ? ('rejected' as const)
              : ('open' as const),
          completed: [...state.completed, 'approval' as const],
        };
      },
    )
    .addNode('issue_refund', node('issue_refund'), {
      retryPolicy: { maxAttempts: 1 },
    })
    .addNode('send_email', node('send_email'), {
      retryPolicy: { maxAttempts: 1 },
    })
    .addNode('close_ticket', node('close_ticket'), {
      retryPolicy: { maxAttempts: 1 },
    })
    .addEdge(START, 'classify')
    .addEdge('classify', 'retrieve_policy')
    .addEdge('retrieve_policy', 'draft_reply')
    .addEdge('draft_reply', 'risk_check')
    .addEdge('risk_check', 'approval')
    .addConditionalEdges(
      'approval',
      (state) => (state.approvalAction === 'reject' ? END : 'issue_refund'),
      [END, 'issue_refund'],
    )
    .addEdge('issue_refund', 'send_email')
    .addEdge('send_email', 'close_ticket')
    .addEdge('close_ticket', END)
    .compile({ checkpointer: saver });
  return { graph, saver, close: () => client.close() };
}
