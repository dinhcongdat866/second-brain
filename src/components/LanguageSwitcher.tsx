import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGS, type Lang } from '../i18n';

const LABELS: Record<Lang, string> = { en: 'EN', vi: 'VI' };

/** Compact EN/VI toggle. The choice persists via the language detector cache. */
export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const current = (i18n.language?.startsWith('vi') ? 'vi' : 'en') as Lang;

  return (
    <div className="lang-switcher" role="group" aria-label="Language">
      {SUPPORTED_LANGS.map((lng) => (
        <button
          key={lng}
          type="button"
          className={'lang-switcher__btn' + (current === lng ? ' is-active' : '')}
          aria-pressed={current === lng}
          onClick={() => i18n.changeLanguage(lng)}
        >
          {LABELS[lng]}
        </button>
      ))}
    </div>
  );
}
