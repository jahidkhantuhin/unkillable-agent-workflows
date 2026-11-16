'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, Menu, X } from 'lucide-react';
import { Navigation } from './navigation';
import { ThemeToggle } from './providers';
import { ApiStatus } from './status';
import { UserMenu } from './user-menu';
export function MobileNavigation() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setOpen(false);
  }, [pathname]);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1024px)');
    const closeOnDesktop = () => {
      if (desktop.matches) setOpen(false);
    };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [open]);
  return (
    <header
      className="border-b border-border bg-background lg:hidden"
      data-testid="mobile-header"
    >
      <div className="flex min-w-0 items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <Link
          href="/"
          onClick={() => setOpen(false)}
          className="flex shrink-0 items-center gap-2 text-lg font-bold tracking-tight"
        >
          <span className="rounded-lg bg-emerald-400 p-2 text-black">
            <Activity aria-hidden="true" className="size-5" />
          </span>
          <span>
            unkillable<span className="text-emerald-500">.</span>
          </span>
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          <ThemeToggle />
          <button
            ref={toggle}
            type="button"
            aria-label={open ? 'Close navigation' : 'Open navigation'}
            aria-expanded={open}
            aria-controls="mobile-navigation-panel"
            onClick={() => setOpen((value) => !value)}
            className="flex size-10 cursor-pointer items-center justify-center rounded-lg border border-border hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {open ? (
              <X aria-hidden="true" className="size-5" />
            ) : (
              <Menu aria-hidden="true" className="size-5" />
            )}
          </button>
        </div>
      </div>
      {open && (
        <div
          id="mobile-navigation-panel"
          className="border-t border-border px-4 pb-5 pt-4 sm:px-6"
        >
          <p className="text-[10px] font-semibold tracking-[.2em] text-muted-foreground">
            WORKSPACE / LOCAL
          </p>
          <Navigation
            className="grid grid-cols-1 min-[400px]:grid-cols-2"
            onNavigate={() => setOpen(false)}
          />
          <div className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
            <ApiStatus />
            <UserMenu />
          </div>
        </div>
      )}
    </header>
  );
}
