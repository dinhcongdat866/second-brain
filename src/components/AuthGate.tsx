import { useAuthStore } from '../stores/authStore';
import { LoginPage } from './LoginPage';

interface Props {
  children: React.ReactNode;
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
    return <LoginPage />;
  }

  // status === 'authenticated' | 'guest'
  return <>{children}</>;
}
