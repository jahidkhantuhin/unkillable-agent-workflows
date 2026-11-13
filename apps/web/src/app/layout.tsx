import type { Metadata } from 'next';
import Link from 'next/link';
import { Activity, ShieldCheck } from 'lucide-react';
import { Providers, ThemeToggle } from '@/components/providers';
import { ApiStatus } from '@/components/status';
import { Navigation } from '@/components/navigation';
import { UserMenu } from '@/components/user-menu';
import './globals.css';
export const metadata: Metadata = {
  title: 'Unkillable · Agent Workflows',
  description: 'Durable agent workflows. Human control. Proof of recovery.',
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>
          <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
            <aside className="border-b border-border p-6 lg:border-r lg:border-b-0">
              <Link
                href="/"
                className="flex items-center gap-3 text-xl font-bold tracking-tight"
              >
                <span className="rounded-lg bg-emerald-400 p-2 text-black">
                  <Activity className="size-5" />
                </span>
                unkillable<span className="text-emerald-500">.</span>
              </Link>
              <p className="mt-8 text-[10px] font-semibold tracking-[.2em] text-muted-foreground">
                WORKSPACE / LOCAL
              </p>
              <Navigation />
              <div className="mt-14 rounded-xl border border-border p-4 text-xs text-muted-foreground">
                <ShieldCheck className="mb-3 size-5 text-emerald-500" />
                <p>Local sandbox</p>
                <p className="mt-2 leading-relaxed">
                  Fake payments. Local email. Built for safe experiments.
                </p>
              </div>
            </aside>
            <div>
              <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-5 lg:px-10">
                <span className="text-sm text-muted-foreground">
                  Platform / Overview
                </span>
                <div className="flex items-center gap-3">
                  <ApiStatus />
                  <ThemeToggle />
                  <UserMenu />
                </div>
              </header>
              <main className="mx-auto max-w-7xl px-6 py-12 lg:px-12">
                {children}
              </main>
              <footer className="px-6 py-8 text-xs text-muted-foreground lg:px-12">
                Jahid Khan Tuhin · Full Stack JavaScript Engineer
              </footer>
            </div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
