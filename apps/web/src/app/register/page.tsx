import { redirect } from 'next/navigation';
import { AuthForm } from '@/components/auth-form';
import { serverIdentity } from '@/lib/server-auth';
export default async function Register() {
  if (await serverIdentity()) redirect('/runs');
  return <AuthForm mode="register" />;
}
