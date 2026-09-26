'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, BookOpen, ClipboardCheck, Loader2 } from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

import { MemberAvatar } from './member-avatar';
import { useSignedInMember } from './use-signed-in-member';

interface FamilyMember {
  ownerId: string;
  login: string;
  name: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  courseCount: number;
  lastSeenAt: string;
}

interface Course {
  stageId: string;
  name: string;
  updatedAt: number;
}

interface QuizResult {
  attemptId: string;
  stageId: string;
  stageName: string | null;
  courseDeleted: boolean;
  sceneTitle: string | null;
  inProgress: boolean;
  earned: number | null;
  total: number | null;
  quizChanged: boolean;
  at: string;
}

type Load<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: T };

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  return (await response.json()) as T;
}

function formatWhen(iso: string, locale: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Admins only: members, then one member's courses and quiz results. */
export function FamilyPage() {
  const { t, locale } = useI18n();
  const { member, loading } = useSignedInMember();
  const [members, setMembers] = useState<Load<FamilyMember[]>>({ status: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  const [courses, setCourses] = useState<Load<Course[]>>({ status: 'loading' });
  const [results, setResults] = useState<Load<QuizResult[]>>({ status: 'loading' });

  useEffect(() => {
    if (!member?.isAdmin) return;
    getJson<{ members: FamilyMember[] }>('/api/admin/members')
      .then((body) => {
        setMembers({ status: 'ready', data: body.members });
        setSelected(
          (current) =>
            current ??
            body.members.find((item) => !item.isAdmin)?.ownerId ??
            body.members[0]?.ownerId ??
            null,
        );
      })
      .catch(() => setMembers({ status: 'error' }));
  }, [member]);

  const choose = (ownerId: string) => {
    if (ownerId === selected) return;
    setCourses({ status: 'loading' });
    setResults({ status: 'loading' });
    setSelected(ownerId);
  };

  useEffect(() => {
    if (!selected) return;
    const base = `/api/admin/members/${encodeURIComponent(selected)}`;
    getJson<{ courses: Course[] }>(`${base}/stages`)
      .then((body) => setCourses({ status: 'ready', data: body.courses }))
      .catch(() => setCourses({ status: 'error' }));
    getJson<{ results: QuizResult[] }>(`${base}/quiz-results`)
      .then((body) => setResults({ status: 'ready', data: body.results }))
      .catch(() => setResults({ status: 'error' }));
  }, [selected]);

  const grouped = useMemo(() => {
    if (results.status !== 'ready') return [];
    const groups = new Map<string, { title: string; deleted: boolean; rows: QuizResult[] }>();
    for (const row of results.data) {
      const group = groups.get(row.stageId) ?? {
        title: row.stageName ?? row.stageId,
        deleted: row.courseDeleted,
        rows: [],
      };
      group.rows.push(row);
      groups.set(row.stageId, group);
    }
    return [...groups.entries()];
  }, [results]);

  if (loading) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </main>
    );
  }
  if (!member?.isAdmin) {
    return (
      <main className="mx-auto max-w-xl px-4 py-24 text-center text-muted-foreground">
        {t('auth.notAllowed')}
      </main>
    );
  }

  const current =
    members.status === 'ready' ? members.data.find((item) => item.ownerId === selected) : undefined;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:py-12" data-testid="family-page">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {t('auth.back')}
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">{t('auth.familyTitle')}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t('auth.familyDescription')}</p>

      <section className="mt-8">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('auth.members')}
        </h2>
        {members.status === 'loading' && <Loader2 className="size-4 animate-spin" />}
        {members.status === 'error' && <p className="text-destructive">{t('auth.loadFailed')}</p>}
        {members.status === 'ready' && (
          <ul className="flex flex-wrap gap-2" data-testid="family-members">
            {members.data.map((item) => (
              <li key={item.ownerId}>
                <button
                  type="button"
                  onClick={() => choose(item.ownerId)}
                  className={cn(
                    'flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition',
                    item.ownerId === selected
                      ? 'border-violet-500 bg-violet-50 dark:bg-violet-900/30'
                      : 'border-border hover:border-violet-400/60',
                  )}
                  title={t('auth.lastSeen', { time: formatWhen(item.lastSeenAt, locale) })}
                >
                  <MemberAvatar name={item.name} avatarUrl={item.avatarUrl} />
                  <span className="font-medium">{item.name}</span>
                  {item.isAdmin && (
                    <span className="text-[10px] font-semibold text-violet-600 dark:text-violet-300">
                      {t('auth.parentBadge')}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {t('auth.courseCount', { count: item.courseCount })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {current && (
        <div className="mt-10 grid gap-8 lg:grid-cols-2">
          <section data-testid="family-courses">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <BookOpen className="size-4" />
              {t('auth.courses')} · {current.name}
            </h2>
            {courses.status === 'loading' && <Loader2 className="size-4 animate-spin" />}
            {courses.status === 'error' && (
              <p className="text-destructive">{t('auth.loadFailed')}</p>
            )}
            {courses.status === 'ready' &&
              (courses.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('auth.noCourses')}</p>
              ) : (
                <ul className="divide-y divide-border rounded-xl border border-border">
                  {courses.data.map((course) => (
                    <li key={course.stageId} className="flex items-center gap-3 px-4 py-3">
                      <span className="min-w-0 flex-1 truncate">{course.name}</span>
                      <Link
                        href={`/classroom/${course.stageId}`}
                        className="shrink-0 text-sm text-violet-600 hover:underline dark:text-violet-300"
                      >
                        {t('auth.open')}
                      </Link>
                    </li>
                  ))}
                </ul>
              ))}
          </section>

          <section data-testid="family-quiz-results">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <ClipboardCheck className="size-4" />
              {t('auth.quizResults')} · {current.name}
            </h2>
            {results.status === 'loading' && <Loader2 className="size-4 animate-spin" />}
            {results.status === 'error' && (
              <p className="text-destructive">{t('auth.loadFailed')}</p>
            )}
            {results.status === 'ready' && grouped.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('auth.noQuizResults')}</p>
            )}
            <div className="space-y-4">
              {grouped.map(([stageId, group]) => (
                <div key={stageId} className="rounded-xl border border-border">
                  <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-sm font-medium">
                    <span className="min-w-0 flex-1 truncate">{group.title}</span>
                    {group.deleted && (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                        {t('auth.deletedCourse')}
                      </span>
                    )}
                  </div>
                  <ul className="divide-y divide-border">
                    {group.rows.map((row) => (
                      <li key={row.attemptId} className="px-4 py-2.5 text-sm">
                        <div className="flex items-baseline gap-3">
                          <span className="min-w-0 flex-1 truncate text-muted-foreground">
                            {row.sceneTitle ?? '—'}
                          </span>
                          <span className="shrink-0 font-semibold tabular-nums">
                            {row.inProgress
                              ? t('auth.inProgress')
                              : `${row.earned ?? 0} / ${row.total ?? '—'}`}
                          </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                          <span>{formatWhen(row.at, locale)}</span>
                          {row.quizChanged && (
                            <span className="text-amber-600 dark:text-amber-400">
                              {t('auth.quizChanged')}
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
