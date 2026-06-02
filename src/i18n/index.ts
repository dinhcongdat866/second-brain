import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './locales/en.json';
import vi from './locales/vi.json';

export const SUPPORTED_LANGS = ['en', 'vi'] as const;
export type Lang = (typeof SUPPORTED_LANGS)[number];

/**
 * App locale. Default is English so a first-time / foreign visitor sees English;
 * a Vietnamese browser (or a saved choice) gets Vietnamese. The user's manual
 * pick is persisted in localStorage and wins over the browser language.
 */
i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      vi: { translation: vi },
    },
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGS,
    nonExplicitSupportedLngs: true, // map "vi-VN" → "vi"
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'lang',
      caches: ['localStorage'],
    },
    interpolation: { escapeValue: false }, // React already escapes
  });

/** BCP-47 locale for Intl date/number formatting derived from the active lang. */
export function intlLocale(): string {
  return i18n.language?.startsWith('vi') ? 'vi-VN' : 'en-US';
}

export default i18n;
