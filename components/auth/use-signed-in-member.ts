'use client';

import { useEffect, useState } from 'react';

import { getSignedInMember, type ClientMember } from '@/lib/auth/client-member';
import { isClientAuthModeEnabled } from '@/lib/auth/public-mode';

export interface SignedInMemberState {
  /** The build has signed-header sign-in; everything auth-related renders only then. */
  enabled: boolean;
  member: ClientMember | null;
  loading: boolean;
}

/** The signed-in member for UI; inert (no request) in a build without sign-in. */
export function useSignedInMember(): SignedInMemberState {
  const enabled = isClientAuthModeEnabled();
  const [state, setState] = useState<{ member: ClientMember | null; loading: boolean }>({
    member: null,
    loading: enabled,
  });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    getSignedInMember()
      .then((member) => {
        if (!cancelled) setState({ member, loading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ member: null, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return { enabled, ...state };
}
