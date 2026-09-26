'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Share2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store';
import { cn } from '@/lib/utils';

import { MemberAvatar } from './member-avatar';
import { useSignedInMember } from './use-signed-in-member';

interface Person {
  login: string;
  name: string;
  avatarUrl: string | null;
}

async function readRecipients(response: Response): Promise<Person[]> {
  if (!response.ok) throw new Error(`share request failed (${response.status})`);
  return ((await response.json()) as { recipients: Person[] }).recipients;
}

/**
 * The classroom header's Share button (design §5): owner only. Ownership is
 * the shares endpoint's answer (404 for anyone but the owner), so no other
 * signal is needed. Renders nothing in a build without sign-in.
 */
export function ShareCourseButton({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const { enabled, member } = useSignedInMember();
  const stageId = useStageStore((s) => s.stage?.id);
  // Keyed by endpoint so a stale answer for another course is never shown.
  const [loaded, setLoaded] = useState<{ endpoint: string; list: Person[] | null } | null>(null);
  const [members, setMembers] = useState<Person[]>([]);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const endpoint = stageId ? `/api/stages/${encodeURIComponent(stageId)}/shares` : null;
  const recipients = loaded && loaded.endpoint === endpoint ? loaded.list : null;
  const setRecipients = useCallback(
    (list: Person[]) => endpoint && setLoaded({ endpoint, list }),
    [endpoint],
  );

  useEffect(() => {
    if (!enabled || !member || !endpoint) return;
    let cancelled = false;
    fetch(endpoint, { cache: 'no-store' })
      .then((response) => (response.ok ? readRecipients(response) : null))
      .then((list) => {
        if (!cancelled) setLoaded({ endpoint, list });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, member, endpoint]);

  useEffect(() => {
    if (!open) return;
    fetch('/api/auth/members', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : { members: [] }))
      .then((body: { members?: Person[] }) => setMembers(body.members ?? []))
      .catch(() => setMembers([]));
  }, [open]);

  const candidates = useMemo(() => {
    const taken = new Set((recipients ?? []).map((person) => person.login));
    return members.filter((person) => person.login !== member?.login && !taken.has(person.login));
  }, [members, recipients, member]);

  const mutate = useCallback(
    async (request: () => Promise<Response>) => {
      setBusy(true);
      setError(false);
      try {
        setRecipients(await readRecipients(await request()));
        setChoice('');
      } catch {
        setError(true);
      } finally {
        setBusy(false);
      }
    },
    [setRecipients],
  );

  if (!enabled || !endpoint || recipients === null) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'shrink-0 inline-flex items-center gap-1.5 rounded-full p-2 text-gray-400 transition-all hover:bg-white hover:text-gray-800 hover:shadow-sm dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-gray-200',
          compact && 'p-1.5',
        )}
        aria-label={t('auth.share')}
        title={t('auth.share')}
        data-testid="share-course-button"
      >
        <Share2 className="size-4" />
        {recipients.length > 0 && (
          <span className="text-[11px] font-semibold tabular-nums">{recipients.length}</span>
        )}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md" data-testid="share-dialog">
          <DialogHeader>
            <DialogTitle>{t('auth.shareTitle')}</DialogTitle>
            <DialogDescription>{t('auth.shareDescription')}</DialogDescription>
          </DialogHeader>

          {candidates.length > 0 ? (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!choice) return;
                void mutate(() =>
                  fetch(endpoint, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ login: choice }),
                  }),
                );
              }}
            >
              <select
                value={choice}
                onChange={(event) => setChoice(event.target.value)}
                className="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm dark:bg-input/30"
                aria-label={t('auth.choosePerson')}
                data-testid="share-member-select"
              >
                <option value="">{t('auth.choosePerson')}</option>
                {candidates.map((person) => (
                  <option key={person.login} value={person.login}>
                    {person.name} ({person.login})
                  </option>
                ))}
              </select>
              <Button type="submit" disabled={!choice || busy} data-testid="share-add">
                {busy ? <Loader2 className="size-4 animate-spin" /> : t('auth.add')}
              </Button>
            </form>
          ) : (
            <p className="text-muted-foreground">{t('auth.noOtherMembers')}</p>
          )}

          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('auth.sharedWith')}
            </div>
            {recipients.length === 0 ? (
              <p className="text-muted-foreground">{t('auth.notSharedYet')}</p>
            ) : (
              <ul className="space-y-2" data-testid="share-recipients">
                {recipients.map((person) => (
                  <li key={person.login} className="flex items-center gap-2">
                    <MemberAvatar name={person.name} avatarUrl={person.avatarUrl} />
                    <span className="min-w-0 flex-1 truncate">
                      {person.name} <span className="text-muted-foreground">({person.login})</span>
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy}
                      aria-label={`${t('auth.remove')} ${person.name}`}
                      onClick={() =>
                        void mutate(() =>
                          fetch(`${endpoint}?login=${encodeURIComponent(person.login)}`, {
                            method: 'DELETE',
                          }),
                        )
                      }
                    >
                      <X className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {error && <p className="text-destructive">{t('auth.shareFailed')}</p>}
        </DialogContent>
      </Dialog>
    </>
  );
}
