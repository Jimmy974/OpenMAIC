'use client';

import { cn } from '@/lib/utils';

/** A member's avatar, or their initial when the proxy sent none. */
export function MemberAvatar({
  name,
  avatarUrl,
  className,
}: {
  name: string;
  avatarUrl: string | null;
  className?: string;
}) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        referrerPolicy="no-referrer"
        className={cn('size-6 rounded-full object-cover', className)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-6 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200',
        'inline-flex items-center justify-center text-[11px] font-semibold uppercase',
        className,
      )}
    >
      {Array.from(name.trim())[0] ?? '?'}
    </span>
  );
}
