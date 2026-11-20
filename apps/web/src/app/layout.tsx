import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { Activity, ShieldCheck } from 'lucide-react';
import { Providers, ThemeToggle } from '@/components/providers';
import { ApiStatus } from '@/components/status';
import { Navigation } from '@/components/navigation';
import { UserMenu } from '@/components/user-menu';
import { serverIdentity } from '@/lib/server-auth';
import './globals.css';
import { ChaosBanner } from '@/components/chaos-panel';
import { MobileNavigation } from '@/components/mobile-navigation';
import { ApprovalBell } from '@/components/approval-bell';
export const metadata: Metadata = {
  appleWebApp: {
    capable: true,
    title: 'Unkillable',
    statusBarStyle: 'default',
  },
  icons: { apple: '/icons/app-192.png' },
  title: 'Unkillable · Agent Workflows',
  description: 'Durable agent workflows. Human control. Proof of recovery.',
};
export const viewport: Viewport = { themeColor: '#0b100e' };
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Public pages still render if the API is starting; the client offers retry.
  const initialIdentity = await serverIdentity().catch(() => undefined);
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers initialIdentity={initialIdentity}>
          <div className="min-h-screen lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
            <MobileNavigation />
            <aside className="hidden border-border p-6 lg:block lg:border-r">
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
            <div className="min-w-0">
              <header className="hidden flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-5 lg:flex lg:px-10">
                <span className="text-sm text-muted-foreground">
                  Platform / Overview
                </span>
                <div className="flex min-w-0 flex-wrap items-center gap-3">
                  <ApiStatus />
                  <ThemeToggle />
                  <ApprovalBell />
                  <UserMenu />
                </div>
              </header>
              <ChaosBanner />
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
