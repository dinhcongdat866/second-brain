import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../stores/authStore';

type Tab = 'signin' | 'signup';

export function LoginPage() {
  const { t } = useTranslation();
  const { signInWithGoogle, signInWithEmail, signUpWithEmail, continueAsGuest } = useAuthStore();

  const [tab, setTab] = useState<Tab>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signupDone, setSignupDone] = useState(false);

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (tab === 'signin') {
        await signInWithEmail(email, password);
      } else {
        const { error: err } = await signUpWithEmail(email, password);
        if (err) { setError(err); }
        else { setSignupDone(true); }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        {/* Brand */}
        <div className="login-brand">
          <span className="login-brand-icon">✦</span>
          <h1 className="login-brand-name">Second Brain</h1>
          <p className="login-brand-sub">{t('login.tagline')}</p>
        </div>

        {signupDone ? (
          <div className="login-notice">
            <p>{t('login.checkEmail')}</p>
          </div>
        ) : (
          <>
            {/* Google */}
            <button
              type="button"
              className="login-google-btn"
              onClick={signInWithGoogle}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
                <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
                <path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/>
                <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.163 6.656 3.58 9 3.58z"/>
              </svg>
              {t('login.continueWithGoogle')}
            </button>

            <div className="login-divider"><span>{t('login.or')}</span></div>

            {/* Email tabs */}
            <div className="login-tabs">
              <button
                type="button"
                className={'login-tab' + (tab === 'signin' ? ' is-active' : '')}
                onClick={() => { setTab('signin'); setError(null); }}
              >
                {t('login.signIn')}
              </button>
              <button
                type="button"
                className={'login-tab' + (tab === 'signup' ? ' is-active' : '')}
                onClick={() => { setTab('signup'); setError(null); }}
              >
                {t('login.signUp')}
              </button>
            </div>

            <form className="login-form" onSubmit={handleEmailSubmit}>
              <input
                type="email"
                className="login-input"
                placeholder={t('login.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
              <input
                type="password"
                className="login-input"
                placeholder={t('login.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete={tab === 'signin' ? 'current-password' : 'new-password'}
                minLength={6}
              />
              {error && <p className="login-error">{error}</p>}
              <button type="submit" className="login-submit-btn" disabled={loading}>
                {loading ? '…' : tab === 'signin' ? t('login.signIn') : t('login.signUp')}
              </button>
            </form>
          </>
        )}

        {/* Guest */}
        <button type="button" className="login-guest-btn" onClick={continueAsGuest}>
          {t('login.continueAsGuest')}
        </button>
      </div>
    </div>
  );
}
