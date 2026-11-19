'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { registerSchema, loginSchema } from '@unkillable/shared';
import { useAuth } from './auth-provider';
import { Button } from './ui/button';
import { useToast } from './toast-provider';
export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const toast = useToast();
  const router = useRouter();
  const { refresh } = useAuth();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const register = mode === 'register';
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    const input = {
      email: form.get('email'),
      password: form.get('password'),
      ...(register ? { name: form.get('name') } : {}),
    };
    const parsed = (register ? registerSchema : loginSchema).safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check your details');
      toast.error(parsed.error);
      return;
    }
    setPending(true);
    try {
      const response = await fetch(`/api/backend/auth/${mode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error?.message ?? 'Unable to sign in');
      await refresh();
      toast.success(
        register
          ? 'Account created with viewer access.'
          : 'Signed in successfully.',
      );
      router.replace(
        new URL(window.location.href).searchParams.get('next') === '/approve'
          ? '/approve'
          : '/runs',
      );
      router.refresh();
    } catch (error) {
      toast.error(error, 'Unable to connect. Try again.');
      setError(
        error instanceof Error
          ? error.message
          : 'Unable to connect. Try again.',
      );
    } finally {
      setPending(false);
    }
  }
  const inputClass =
    'mt-2 h-11 w-full rounded-lg border border-border bg-background px-3 text-sm outline-offset-2 focus:outline-emerald-500';
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-border bg-muted/20 p-8">
      <p className="text-xs font-medium tracking-widest text-emerald-500">
        YOUR WORKSPACE
      </p>
      <h1 className="mt-4 text-3xl font-semibold">
        {register ? 'Create your account' : 'Welcome back'}
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        {register
          ? 'Start with viewer access. An administrator manages workspace roles.'
          : 'Sign in to access your workflow workspace.'}
      </p>
      <form onSubmit={submit} className="mt-8 space-y-5">
        {register && (
          <label className="block text-sm">
            Name
            <input
              name="name"
              autoComplete="name"
              required
              maxLength={100}
              className={inputClass}
            />
          </label>
        )}
        <label className="block text-sm">
          Email
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            className={inputClass}
          />
        </label>
        <label className="block text-sm">
          Password
          <input
            name="password"
            type="password"
            autoComplete={register ? 'new-password' : 'current-password'}
            required
            minLength={register ? 12 : 1}
            maxLength={128}
            className={inputClass}
          />
          {register && (
            <span className="mt-2 block text-xs text-muted-foreground">
              Use at least 12 characters.
            </span>
          )}
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-500">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? 'Please wait…' : register ? 'Create account' : 'Sign in'}
        </Button>
      </form>
      <p className="mt-6 text-sm text-muted-foreground">
        {register ? 'Already have an account?' : 'New here?'}{' '}
        <Link
          className="text-foreground underline underline-offset-4"
          href={register ? '/login' : '/register'}
        >
          {register ? 'Sign in' : 'Create an account'}
        </Link>
      </p>
    </div>
  );
}
