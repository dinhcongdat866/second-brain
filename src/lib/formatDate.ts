/**
 * Smart relative/contextual date formatting.
 *
 * - Same calendar day  → "4:54 CH"
 * - Yesterday          → "Hôm qua 4:54 CH"
 * - Within 7 days      → "Thứ Ba 4:54 CH"
 * - Same year          → "12 thg 5 4:54 CH"
 * - Older              → "12 thg 5, 2023 4:54 CH"
 */
export function formatSmartDate(iso: string): string {
  try {
    const date = new Date(iso);
    const now  = new Date();

    // Compare calendar days, not raw ms (avoids "23:59 yesterday" edge case)
    const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const today   = new Date(now.getFullYear(),  now.getMonth(),  now.getDate());
    const diffDays = Math.round(
      (today.getTime() - dateDay.getTime()) / (1000 * 60 * 60 * 24),
    );

    const timeStr = date.toLocaleTimeString('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
    });

    if (diffDays === 0) return timeStr;
    if (diffDays === 1) return `Hôm qua ${timeStr}`;
    if (diffDays < 7) {
      const dayName = date.toLocaleDateString('vi-VN', { weekday: 'long' });
      return `${dayName} ${timeStr}`;
    }
    if (date.getFullYear() === now.getFullYear()) {
      const dateStr = date.toLocaleDateString('vi-VN', { month: 'short', day: 'numeric' });
      return `${dateStr} ${timeStr}`;
    }
    const dateStr = date.toLocaleDateString('vi-VN', {
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
    return new Date(iso).toLocaleString('vi-VN', {
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
