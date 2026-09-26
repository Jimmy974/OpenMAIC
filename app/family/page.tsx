import { notFound } from 'next/navigation';

import { FamilyPage } from '@/components/auth/family-page';
import { isClientAuthModeEnabled } from '@/lib/auth/public-mode';

/**
 * The parents' Family page (design §5). Exists only in a sign-in build; the
 * data behind it is admin-only on the server, whoever renders this shell.
 */
export default function Page() {
  if (!isClientAuthModeEnabled()) notFound();
  return <FamilyPage />;
}
