'use client';
import { ThemeProvider, useTheme } from 'next-themes';
import { Moon, Sun } from 'lucide-react';
import { Button } from './ui/button';
import { AuthProvider } from './auth-provider';
import type { Identity } from '@unkillable/shared';
import { ToastProvider, useToast } from './toast-provider';
import { PwaRegistration } from './pwa';
export function Providers({
  children,
  initialIdentity,
}: {
  children: React.ReactNode;
  initialIdentity?: Identity | null;
}) {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
      <ToastProvider>
        <PwaRegistration />
        <AuthProvider initialIdentity={initialIdentity}>
          {children}
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const toast = useToast();
  return (
    <Button
      variant="outline"
      size="icon"
      aria-label="Toggle color theme"
      onClick={() => {
        const next = resolvedTheme === 'dark' ? 'light' : 'dark';
        setTheme(next);
        toast.success(`${next === 'dark' ? 'Dark' : 'Light'} theme enabled.`);
      }}
    >
      <Sun className="size-4 dark:hidden" />
      <Moon className="hidden size-4 dark:block" />
    </Button>
  );
}
