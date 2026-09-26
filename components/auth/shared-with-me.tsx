'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Share2 } from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';

import { useSignedInMember } from './use-signed-in-member';

interface IncomingShare {
  stageId: string;
  name: string;
  ownerLogin: string | null;
  ownerName: string | null;
  sharedAt: string;
}

/**
 * Home page "Shared with me" (design §5): live courses other members shared
 * with the signed-in member. Renders nothing without sign-in or shares.
 */
export function SharedWithMe() {
  const { t } = useI18n();
  const router = useRouter();
  const { enabled, member } = useSignedInMember();
  const [shares, setShares] = useState<IncomingShare[]>([]);

  useEffect(() => {
    if (!enabled || !member) return;
    let cancelled = false;
    fetch('/api/shares/incoming', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : { shares: [] }))
      .then((body: { shares?: IncomingShare[] }) => {
        if (!cancelled) setShares(body.shares ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, member]);

  if (!enabled || shares.length === 0) return null;
  return (
    <section className="relative z-10 mt-10 w-full max-w-6xl" data-testid="shared-with-me">
      <div className="flex items-center gap-4 h-9">
        <div className="flex-1 h-px bg-border/40" />
        <span className="flex items-center gap-2 text-[13px] text-muted-foreground/60 select-none">
          <Share2 className="size-3.5" />
          {t('auth.sharedWithMe')}
          <span className="text-[11px] tabular-nums opacity-60">{shares.length}</span>
        </span>
        <div className="flex-1 h-px bg-border/40" />
      </div>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shares.map((share) => (
          <li key={share.stageId}>
            <button
              type="button"
              onClick={() => router.push(`/classroom/${share.stageId}`)}
              className="w-full rounded-xl border border-border/60 bg-white/70 px-4 py-3 text-left shadow-sm transition hover:border-violet-400/60 hover:shadow dark:bg-gray-900/40"
            >
              <div className="truncate font-medium text-foreground">{share.name}</div>
              <div className="mt-1 truncate text-xs text-muted-foreground">
                {t('auth.sharedBy', { name: share.ownerName ?? share.ownerLogin ?? '?' })}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
