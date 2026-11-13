'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { hasPermission, sectionPermissions } from '@unkillable/shared';
import { useAuth } from './auth-provider';
const sections = ['Runs', 'Approvals', 'Workflows', 'Chaos', 'Analytics'];
export function Navigation() {
  const pathname = usePathname();
  const { identity } = useAuth();
  return (
    <nav
      aria-label="Main navigation"
      className="mt-4 flex flex-wrap gap-2 lg:flex-col"
    >
      {sections.map((name, index) => {
        const permission =
          sectionPermissions[
            name.toLowerCase() as keyof typeof sectionPermissions
          ];
        if (!identity || !hasPermission(identity.role, permission)) return null;
        const href = `/${name.toLowerCase()}`;
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={name}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center justify-between rounded-lg px-3 py-3 text-sm hover:bg-muted hover:text-foreground',
              active ? 'bg-muted text-foreground' : 'text-muted-foreground',
            )}
          >
            <span>
              <span className="mr-3 font-mono text-xs opacity-40">
                0{index + 1}
              </span>
              {name}
            </span>
            <ArrowUpRight className="size-3" />
          </Link>
        );
      })}
    </nav>
  );
}
