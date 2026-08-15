import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { LoginPage } from './LoginPage';
import { SharedDocPage } from './SharedDocPage';
import { docIdFromRoute } from '../lib/router';
import { fetchShare, type ShareInfo } from '../lib/sharing';

interface Props {
  children: React.ReactNode;
}

/**
 * A link to a shared document, opened by someone with no account.
 *
 * This exists because the gate below would otherwise show a login page, and a
 * public link that demands a login is not a public link. It resolves the id
 * against the backend on its own — there is no registry and no session to
 * consult — and falls back to the login page when the answer is no.
 */
function AnonymousVisitor({ docId }: { docId: string }) {
  const [share, setShare] = useState<ShareInfo | null | 'loading'>('loading');

  useEffect(() => {
    let cancelled = false;
    fetchShare(docId)
      .then((s) => { if (!cancelled) setShare(s); })
      .catch(() => { if (!cancelled) setShare(null); });
    return () => { cancelled = true; };
  }, [docId]);

  if (share === 'loading') {
    return (
      <div className="auth-loading">
        <span className="auth-loading__spinner" aria-hidden="true" />
      </div>
    );
  }
  // Not shared, or no such document. Offer the login page rather than a dead
  // end: the most likely visitor here is the owner on a signed-out browser.
  if (share === null || share.linkAccess === 'none') return <LoginPage />;

  return (
    <SharedDocPage
      docId={docId}
      ownerId={share.ownerId}
      canWrite={share.canWrite}
      name={share.name}
    />
  );
}

/**
 * Renders a loading spinner, the login page, or the app depending on auth state.
 * Guest mode falls through to `children` so the full app is available.
 */
export function AuthGate({ children }: Props) {
  const status = useAuthStore((s) => s.status);

  if (status === 'loading') {
    return (
      <div className="auth-loading">
        <span className="auth-loading__spinner" aria-hidden="true" />
      </div>
    );
  }

  if (status === 'unauthenticated') {
    const docId = docIdFromRoute();
    return docId ? <AnonymousVisitor docId={docId} /> : <LoginPage />;
  }

  // status === 'authenticated' | 'guest'
  return <>{children}</>;
}
