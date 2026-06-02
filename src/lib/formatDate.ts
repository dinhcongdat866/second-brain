import i18n, { intlLocale } from '../i18n';

/**
 * Smart relative/contextual date formatting, locale-aware (en-US / vi-VN).
 *
 * - Same calendar day  → "4:54 PM"
 * - Yesterday          → "Yesterday 4:54 PM"
 * - Within 7 days      → "Tuesday 4:54 PM"
 * - Same year          → "May 12 4:54 PM"
 * - Older              → "May 12, 2023 4:54 PM"
 */
export function formatSmartDate(iso: string): string {
  try {
    const date = new Date(iso);
    const now = new Date();
    const locale = intlLocale();

    // Compare calendar days, not raw ms (avoids "23:59 yesterday" edge case)
    const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffDays = Math.round(
      (today.getTime() - dateDay.getTime()) / (1000 * 60 * 60 * 24),
    );

    const timeStr = date.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
    });

    if (diffDays === 0) return timeStr;
    if (diffDays === 1) return `${i18n.t('date.yesterday')} ${timeStr}`;
    if (diffDays < 7) {
      const dayName = date.toLocaleDateString(locale, { weekday: 'long' });
      return `${dayName} ${timeStr}`;
    }
    if (date.getFullYear() === now.getFullYear()) {
      const dateStr = date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
      return `${dateStr} ${timeStr}`;
    }
    const dateStr = date.toLocaleDateString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    return `${dateStr} ${timeStr}`;
  } catch {
    return '';
  }
}

/** Full datetime for tooltip (title attribute). */
export function formatFullDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(intlLocale(), {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}
