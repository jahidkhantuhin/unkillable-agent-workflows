import { redirect } from 'next/navigation';
import { AuthForm } from '@/components/auth-form';
import { serverIdentity } from '@/lib/server-auth';
export default async function Login() {
  if (await serverIdentity()) redirect('/runs');
  return <AuthForm mode="login" />;
}
