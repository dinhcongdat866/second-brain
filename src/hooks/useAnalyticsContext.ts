/**
 * Fetches the last 30 days of analytics data once per session and formats it
 * into a compact string for injection into the AI cell system prompt.
 *
 * Mirrors the pattern of useMemory — returns a stable getter so the string
 * can be read at request-time without triggering re-renders.
 *
 * Only fetches for authenticated users; guests receive an empty string.
 */
import { useCallback, useEffect, useRef } from 'react';
import { apiFetch } from '../lib/http';
import { evaluatePatterns, type CategoryBreakdown, type MoodPoint, type DetectedPattern } from '../lib/analyticsRules';

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

function formatAnalyticsContext(
  breakdown: CategoryBreakdown[],
  timeline: MoodPoint[],
  patterns: DetectedPattern[],
  from: string,
  to: string,
): string {
  const lines: string[] = [];
  const trend = { up: '↑', down: '↓', stable: '→' } as const;

  lines.push(`--- PERSONAL ANALYTICS (${from} → ${to}) ---`);

  // Category breakdown
  const total = breakdown.reduce((s, b) => s + b.count, 0);
  if (total > 0) {
    lines.push(`Category breakdown (${total} todos classified):`);
    for (const b of breakdown.slice(0, 8)) {
      lines.push(`  ${b.category.padEnd(22)} ${b.pct.toFixed(1).padStart(5)}% ${trend[b.trend]}`);
    }
  } else {
    lines.push('Category breakdown: no classified todos yet.');
  }

  // Mood summary
  const logged = timeline.filter((p) => p.energy !== null);
  if (logged.length > 0) {
    const avg = logged.reduce((s, p) => s + (p.energy as number), 0) / logged.length;
    const low  = logged.filter((p) => (p.energy as number) <= 2).length;
    const high = logged.filter((p) => (p.energy as number) >= 4).length;
    lines.push(
      `\nMood (${logged.length}/${timeline.length} days logged): avg ${avg.toFixed(1)}/5,` +
      ` ${low} low day${low !== 1 ? 's' : ''}, ${high} high day${high !== 1 ? 's' : ''}`
    );
  } else {
    lines.push(`\nMood: 0/${timeline.length} days logged — no mood data.`);
  }

  // Active patterns
  if (patterns.length > 0) {
    lines.push('\nActive patterns:');
    for (const p of patterns) {
      lines.push(`  [${p.severity.toUpperCase()}] ${p.rule} — ${p.description}`);
    }
  }

  lines.push(
    '\nUse this data when answering questions about the user\'s life, habits, or patterns.' +
    ' If data is insufficient to answer confidently, say so directly.'
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAnalyticsContext(enabled: boolean): { getAnalyticsContext: () => string } {
  const contextRef = useRef('');

  useEffect(() => {
    if (!enabled) return;

    const today = new Date();
    const to   = today.toISOString().slice(0, 10);
    const from = new Date(today.getTime() - 29 * 86_400_000).toISOString().slice(0, 10);

    apiFetch(`/analytics/report-data?from_date=${from}&to_date=${to}`)
      .then((r) => r.json())
      .then((data: { categoryBreakdown: CategoryBreakdown[]; moodTimeline: MoodPoint[] }) => {
        const patterns = evaluatePatterns(data.categoryBreakdown, data.moodTimeline);
        contextRef.current = formatAnalyticsContext(
          data.categoryBreakdown,
          data.moodTimeline,
          patterns,
          from,
          to,
        );
      })
      .catch(() => {
        contextRef.current = ''; // fail silently — analytics unavailable, AI still works
      });
  }, [enabled]);

  const getAnalyticsContext = useCallback(() => contextRef.current, []);

  return { getAnalyticsContext };
}
