/** Test-only child process. Operates solely on the caller's isolated test database. */
import { MongoClient } from 'mongodb';
import { effectResultSchema } from '@unkillable/shared';
import { ReliabilityRepository } from '../reliability';
const database = process.env.EFFECT_DATABASE;
if (!database?.startsWith('unkillable_test_'))
  throw new Error('Effect test child requires a disposable test database');
const client = new MongoClient(process.env.EFFECT_URI!);
await client.connect();
const repository = new ReliabilityRepository(client, client.db(database));
process.once('message', () => {
  void (async () => {
    const result = await repository.executeOnce(
      process.env.EFFECT_KEY!,
      async (transaction) => {
        const receipt = await transaction.enqueue('notification', {
          message: 'concurrent local effect',
        });
        return { receipt };
      },
      effectResultSchema,
    );
    if (process.env.EFFECT_CRASH_AFTER_COMMIT === '1') process.exit(137);
    process.send?.({ type: 'result', result }, () => {
      void client.close().then(() => process.exit(0));
    });
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
});
process.send?.({ type: 'ready' });
