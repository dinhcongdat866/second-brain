import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../stores/authStore';

/**
 * Thin banner shown when the user is in guest mode.
 * Warns that data is local-only and offers a sign-in shortcut.
 */
export function GuestBanner() {
  const { t } = useTranslation();
  const { signInWithGoogle } = useAuthStore();

  return (
    <div className="guest-banner" role="status">
      <span className="guest-banner__text">{t('guest.bannerText')}</span>
      <button
        type="button"
        className="guest-banner__btn"
        onClick={signInWithGoogle}
      >
        {t('guest.signIn')}
      </button>
    </div>
  );
}
