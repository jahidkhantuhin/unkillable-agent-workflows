import { MongoClient } from 'mongodb';
import { configSchema } from '../config';
import { bootstrapIndexes } from '../repositories/indexes';
const config = configSchema.parse(process.env);
const client = new MongoClient(config.MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
});
try {
  await client.connect();
  await bootstrapIndexes(client.db());
  console.log('Collections and indexes are ready');
} finally {
  await client.close();
}
