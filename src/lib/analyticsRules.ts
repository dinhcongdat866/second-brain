/**
 * Client-side pattern detection for Personal Analytics.
 * Runs after the frontend receives SQL aggregates from GET /analytics/report-data.
 * Does NOT call the backend — pure computation over the returned data.
 *
 * Rules are defined in localdoc/PERSONAL-ANALYTICS.md §5.
 */
import { CAT } from './taxonomy';

export interface CategoryBreakdown {
  category: string;
  count: number;
  pct: number;
  trend: 'up' | 'down' | 'stable';
}

export interface MoodPoint {
  date: string;
  energy: number | null;
  note?: string | null;
}

export interface DetectedPattern {
  rule: string;
  description: string;
  severity: 'info' | 'notice' | 'alert';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Activities that indicate high cognitive/work load. */
const DEMANDING = new Set([CAT.WORK, CAT.JOB_SEARCH, CAT.PERSONAL_PROJECT]);
/** Activities that indicate recovery. */
const RESTORATIVE = new Set([CAT.REST, CAT.LEISURE]);

/** Returns the longest consecutive streak where `pred` is true, plus its date range. */
function maxStreak(
  points: MoodPoint[],
  pred: (p: MoodPoint) => boolean,
): { streak: number; startDate: string; endDate: string } {
  let best = 0, bestStart = '', bestEnd = '';
  let cur = 0, curStart = '';
  for (const p of points) {
    if (pred(p)) {
      if (cur === 0) curStart = p.date;
      cur++;
      if (cur > best) { best = cur; bestStart = curStart; bestEnd = p.date; }
    } else {
      cur = 0;
    }
  }
  return { streak: best, startDate: bestStart, endDate: bestEnd };
}

function fmtRange(start: string, end: string): string {
  if (start === end) return fmtDate(start);
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  const sm = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return s.getMonth() === e.getMonth()
    ? `${sm}–${e.getDate()}`
    : `${sm} – ${e.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

function fmtDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Main evaluator
// ---------------------------------------------------------------------------

export function evaluatePatterns(
  breakdown: CategoryBreakdown[],
  moodTimeline: MoodPoint[],
): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];
  const byCategory = new Map(breakdown.map((b) => [b.category, b]));

  // ── Rule 1 — Burnout Signal ─────────────────────────────────────────────
  // energy < 3 for 2+ consecutive logged days, OR "Bad mental health" 2+ times.
  const logged = moodTimeline.filter((p) => p.energy !== null);
  const { streak: lowStreak, startDate: ls, endDate: le } = maxStreak(
    logged,
    (p) => (p.energy as number) < 3,
  );
  const badMentalCount = byCategory.get(CAT.BAD_MENTAL_HEALTH)?.count ?? 0;

  if (lowStreak >= 2 || badMentalCount >= 2) {
    const parts: string[] = [];
    if (lowStreak >= 2) parts.push(`energy < 3 for ${lowStreak} consecutive days (${fmtRange(ls, le)})`);
    if (badMentalCount >= 2) parts.push(`"Bad mental health" todos appeared ${badMentalCount}×`);
    patterns.push({
      rule: 'BURNOUT_SIGNAL',
      description: `Burnout signal detected: ${parts.join('; ')}.`,
      severity: 'alert',
    });

    // ── Rule 3 — Recovery Duration (child of burnout) ───────────────────
    const afterBurnout = logged.filter((p) => p.date > le);
    const { streak: recStreak, startDate: rs } = maxStreak(
      afterBurnout,
      (p) => (p.energy as number) >= 3,
    );
    if (recStreak >= 2) {
      const burnStart = new Date(ls + 'T00:00:00').getTime();
      const recStart  = new Date(rs + 'T00:00:00').getTime();
      const days = Math.round((recStart - burnStart) / 86_400_000);
      patterns.push({
        rule: 'RECOVERY_PERIOD',
        description: `Recovery began ~${days} day${days !== 1 ? 's' : ''} after burnout signal (mood ≥ 3 sustained from ${fmtDate(rs)}).`,
        severity: 'info',
      });
    }
  }

  // ── Rule 2 — High Intensity Period ─────────────────────────────────────
  // Demanding categories dominate AND rest/leisure is low.
  const demandingPct = breakdown
    .filter((b) => DEMANDING.has(b.category))
    .reduce((s, b) => s + b.pct, 0);
  const restorativePct = breakdown
    .filter((b) => RESTORATIVE.has(b.category))
    .reduce((s, b) => s + b.pct, 0);

  if (demandingPct >= 60 && restorativePct < 15) {
    patterns.push({
      rule: 'HIGH_INTENSITY',
      description: `High-intensity period: demanding activities ${demandingPct.toFixed(0)}% of todos, rest/leisure only ${restorativePct.toFixed(0)}%. Consider adding recovery time.`,
      severity: 'notice',
    });
  }

  // ── Rule 4 — Low Mood Correlation ──────────────────────────────────────
  const veryLowDays = moodTimeline.filter((p) => (p.energy ?? 5) <= 2);
  if (veryLowDays.length >= 1) {
    const corr: string[] = [];
    if (byCategory.has(CAT.JOB_SEARCH))   corr.push('active job search');
    if (byCategory.has(CAT.BAD_PHYSICAL)) corr.push('physical health issues');
    if (demandingPct >= 55) corr.push('high-intensity work period');

    if (corr.length > 0) {
      patterns.push({
        rule: 'MOOD_CORRELATION',
        description: `Low mood (energy ≤ 2) on ${veryLowDays.length} day${veryLowDays.length > 1 ? 's' : ''}. Possible correlates: ${corr.join(', ')}.`,
        severity: 'info',
      });
    }
  }

  // ── Rule 5 — Category Concentration ───────────────────────────────────
  const concentrated = breakdown.find((b) => b.pct > 40);
  if (concentrated) {
    patterns.push({
      rule: 'CATEGORY_CONCENTRATION',
      description: `"${concentrated.category}" dominated this period at ${concentrated.pct}% of todos — a notably focused phase.`,
      severity: 'info',
    });
  }

  // ── Rule 6 — Job Search Active ────────────────────────────────────────
  const jobSearch = byCategory.get(CAT.JOB_SEARCH);
  if (jobSearch && jobSearch.pct >= 10) {
    const trendLabel = jobSearch.trend === 'up' ? '↑ increasing' : jobSearch.trend === 'down' ? '↓ decreasing' : '→ stable';
    patterns.push({
      rule: 'JOB_SEARCH_ACTIVE',
      description: `Job search active: ${jobSearch.count} todos (${jobSearch.pct}% of total, ${trendLabel} vs prior period).`,
      severity: 'info',
    });
  }

  // ── Rule 7 — Reflection Investment ───────────────────────────────────
  const mental = byCategory.get(CAT.MENTAL_WORK);
  if (mental && mental.pct >= 15) {
    patterns.push({
      rule: 'REFLECTION_WEEK',
      description: `Strong reflection investment this period: ${mental.count} "Mental Work" todos (${mental.pct}%). Historically correlates with improved mood 1–2 weeks later.`,
      severity: 'info',
    });
  }

  return patterns;
}
