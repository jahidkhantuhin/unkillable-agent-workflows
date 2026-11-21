import { MongoClient } from 'mongodb';
import { configSchema } from '../config';
import { seedReleaseDemo } from '../services/demo-seed';
const config = configSchema.parse(process.env),
  client = new MongoClient(config.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });
try {
  await client.connect();
  const result = await seedReleaseDemo(client, config, process.env);
  console.log(
    JSON.stringify(
      {
        ...result,
        note: 'Local synthetic fixture ready; no run started, no password changed, no messages sent. Sign in and choose the order #4821 example.',
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
