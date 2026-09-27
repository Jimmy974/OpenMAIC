/**
 * Classrooms made through the classroom API, saved into a member's course
 * library (signed-header sign-in only).
 *
 * Upstream stores API-made classrooms as files that belong to nobody: they
 * never appear in anyone's library, cannot be shared, and do not reach the
 * Family page. With sign-in on, the finished classroom is also written as a
 * normal course owned by the requested member, and shared with the requested
 * members, so it behaves exactly like one built in the browser.
 */
import type { AppDocumentOutline, AppStage } from '@/lib/document-store/persistence-types';
import { markStageGenerationComplete } from '@/lib/persistence/stage-meta';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import type { SceneOutline } from '@/lib/types/generation';
import type { AppScene } from '@/lib/types/stage';

import { findMemberByLogin } from './members';
import { getAuthDb } from './schema';
import { addShare } from './shares';
import { normalizeLogin, ownerIdForLogin } from './signed-identity';

/**
 * Server-side generation writes this classroom's media (narration audio,
 * generated and source pictures) as absolute URLs on the origin the API was
 * called through — `http://127.0.0.1:3000` for a bot on the server, plain
 * `http://` behind the front proxy. A browser can load neither. Media under
 * this classroom's own `/api/classroom-media/<id>/` path is rewritten to that
 * relative path, which every browser resolves against the page it is on.
 */
export function relativizeClassroomMedia<T>(value: T, stageId: string): T {
  const marker = `/api/classroom-media/${stageId}/`;
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item !== 'string' || !/^https?:\/\//i.test(item)) return item;
      const index = item.indexOf(marker);
      return index > 0 && item.slice(0, index).match(/^https?:\/\/[^/]+$/i)
        ? item.slice(index)
        : item;
    }),
  ) as T;
}

export interface LibraryTarget {
  ownerId: string;
  shareWithOwnerIds: string[];
}

export class LibraryTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LibraryTargetError';
  }
}

/**
 * Resolve `owner` / `shareWith` logins from an API request. The owner may be
 * any login (the course simply lands in that account); share recipients must
 * be members who have opened the site, like the Share dialog requires.
 */
export async function resolveLibraryTarget(input: {
  defaultOwnerId: string;
  owner?: unknown;
  shareWith?: unknown;
}): Promise<LibraryTarget> {
  let ownerId = input.defaultOwnerId;
  if (input.owner !== undefined) {
    if (typeof input.owner !== 'string' || !normalizeLogin(input.owner)) {
      throw new LibraryTargetError('owner must be a login (email address)');
    }
    ownerId = ownerIdForLogin(input.owner);
  }

  const shareWithOwnerIds: string[] = [];
  if (input.shareWith !== undefined) {
    if (
      !Array.isArray(input.shareWith) ||
      input.shareWith.some((item) => typeof item !== 'string')
    ) {
      throw new LibraryTargetError('shareWith must be a list of logins');
    }
    if (input.shareWith.length > 20)
      throw new LibraryTargetError('shareWith is limited to 20 logins');
    const db = await getAuthDb();
    for (const login of input.shareWith as string[]) {
      const member = await findMemberByLogin(db, normalizeLogin(login));
      if (!member) {
        throw new LibraryTargetError(
          `shareWith: "${login}" has not opened the site yet (members must sign in once before they can be shared with)`,
        );
      }
      if (member.ownerId !== ownerId && !shareWithOwnerIds.includes(member.ownerId)) {
        shareWithOwnerIds.push(member.ownerId);
      }
    }
  }
  return { ownerId, shareWithOwnerIds };
}

export async function saveClassroomToLibrary(
  classroom: {
    stage: AppStage;
    scenes: AppScene[];
    outlines: SceneOutline[];
    requirement: string;
    producerRef?: string;
  },
  target: LibraryTarget,
): Promise<void> {
  const now = Date.now();
  const outline: AppDocumentOutline = {
    outlines: classroom.outlines,
    requirement: classroom.requirement,
    generationComplete: true,
    // The server made every page; a browser that opens it must never try to
    // generate "missing" pages.
    producer: 'server-job',
    ...(classroom.producerRef ? { producerRef: classroom.producerRef } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const store = await getOwnerScopedDocumentStore(target.ownerId);
  await store.saveDocument({
    stage: relativizeClassroomMedia(classroom.stage, classroom.stage.id),
    scenes: relativizeClassroomMedia(classroom.scenes, classroom.stage.id),
    outline,
  });
  const db = await getAuthDb();
  await markStageGenerationComplete(db, classroom.stage.id);
  if (target.shareWithOwnerIds.length > 0) {
    for (const recipient of target.shareWithOwnerIds) {
      await addShare(db, classroom.stage.id, target.ownerId, recipient);
    }
  }
}
