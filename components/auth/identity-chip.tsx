'use client';

import Link from 'next/link';
import { Users } from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

import { MemberAvatar } from './member-avatar';
import { useSignedInMember } from './use-signed-in-member';

/**
 * Who the site thinks is signed in (design §5, Premise 5). Parents also get a
 * link to the Family page. Renders nothing in a build without sign-in.
 */
export function IdentityChip({ className }: { className?: string }) {
  const { t } = useI18n();
  const { enabled, member } = useSignedInMember();
  if (!enabled || !member) return null;
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <span
        className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs text-gray-600 dark:text-gray-300"
        title={t('auth.signedInAs', { name: `${member.name} (${member.login})` })}
        data-testid="identity-chip"
      >
        <MemberAvatar name={member.name} avatarUrl={member.avatarUrl} className="size-5" />
        <span className="max-w-[9rem] truncate font-medium">{member.name}</span>
        {member.isAdmin && (
          <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 dark:bg-violet-900/40 dark:text-violet-200">
            {t('auth.parentBadge')}
          </span>
        )}
      </span>
      {member.isAdmin && (
        <Link
          href="/family"
          className="rounded-full p-2 text-gray-400 transition-all hover:bg-white hover:text-gray-800 hover:shadow-sm dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          aria-label={t('auth.familyLink')}
          title={t('auth.familyLink')}
          data-testid="family-link"
        >
          <Users className="size-4" />
        </Link>
      )}
    </div>
  );
}
