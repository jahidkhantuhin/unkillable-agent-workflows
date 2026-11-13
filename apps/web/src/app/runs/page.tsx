import { redirect } from 'next/navigation';
import { serverIdentity } from '@/lib/server-auth';
import { RunsList } from '@/components/runs-list';
export default async function Runs() {
  if (!(await serverIdentity())) redirect('/login');
  return <RunsList />;
}
