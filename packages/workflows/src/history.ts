import { createDemoRuntime } from './runtime';
import { createSupportRuntime } from './support-runtime';
import { createModerationRuntime } from './moderation-runtime';
import {
  demoStateSchema,
  supportStateSchema,
  moderationStateSchema,
} from '@unkillable/shared';
const noop = async () => {};
const forbid = async (): Promise<never> => {
  throw new Error('History inspection cannot execute workflow nodes');
};
export async function createHistoryRuntime(
  workflow: string,
  uri: string,
  dbName: string,
) {
  if (workflow === 'durability-demo')
    return {
      ...(await createDemoRuntime(
        uri,
        dbName,
        { checkpoint: noop, stepStarted: noop, runNode: forbid },
        0,
      )),
      schema: demoStateSchema,
    };
  if (workflow === 'support-ticket-router')
    return {
      ...(await createSupportRuntime(
        uri,
        dbName,
        { checkpoint: noop, stepStarted: noop, runNode: forbid },
        {
          llm: { classify: forbid, draft: forbid },
          retriever: { retrieve: forbid },
          payments: { refund: forbid },
          mailer: { send: forbid },
          tickets: { close: forbid },
        },
      )),
      schema: supportStateSchema,
    };
  if (workflow === 'content-moderation')
    return {
      ...(await createModerationRuntime(
        uri,
        dbName,
        { checkpoint: noop, started: noop, runNode: forbid },
        () => ({ check: forbid, decide: forbid, notify: forbid }),
      )),
      schema: moderationStateSchema,
    };
  throw new Error('Checkpoint inspection is unavailable for this workflow');
}
