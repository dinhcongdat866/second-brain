/**
 * /ai-report page — Personal analytics report.
 *
 * Rendered as a full-screen overlay in App.tsx.
 * Phase 2: SQL data + pattern rules.
 * Phase 3 will add AI narrative (POST /ai-report/generate).
 */
import { useState, useCallback } from 'react';
import { apiFetch } from '../lib/http';
import {
  evaluatePatterns,
  type CategoryBreakdown,
  type MoodPoint,
  type DetectedPattern,
} from '../lib/analyticsRules';
import '../styles/ai-report.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PeriodType = '7' | '30' | '90';

interface ReportData {
  categoryBreakdown: CategoryBreakdown[];
  moodTimeline: MoodPoint[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PERIOD_LABELS: Record<PeriodType, string> = {
  '7':  'Last 7 days',
  '30': 'Last 30 days',
  '90': 'Last 90 days',
};

function getPeriodDates(type: PeriodType): { from: string; to: string } {
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const days = parseInt(type, 10) - 1;
  const from = new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

const TREND_ICON: Record<CategoryBreakdown['trend'], string> = {
  up: '↑', down: '↓', stable: '→',
};

const MOOD_EMOJI: Record<number, string> = {
  1: '😴', 2: '😞', 3: '😐', 4: '🙂', 5: '🔥',
};

const ENERGY_COLOR: Record<number, string> = {
  1: '#ef4444', 2: '#f97316', 3: '#eab308', 4: '#22c55e', 5: '#10b981',
};

const SEVERITY_ICON: Record<DetectedPattern['severity'], string> = {
  alert: '🔴', notice: '🟡', info: 'ℹ️',
};

function shortDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CategoryBar({ item, maxPct }: { item: CategoryBreakdown; maxPct: number }) {
  const fillW = maxPct > 0 ? (item.pct / maxPct) * 100 : 0;
  return (
    <div className="ar-bar-row">
      <span className="ar-bar-label" title={item.category}>{item.category}</span>
      <div className="ar-bar-track">
        <div className="ar-bar-fill" style={{ width: `${fillW}%` }} />
      </div>
      <span className="ar-bar-meta">
        {item.pct}%
        <span className={`ar-trend ar-trend--${item.trend}`}>
          {TREND_ICON[item.trend]}
        </span>
      </span>
    </div>
  );
}

function MoodTimeline({ timeline }: { timeline: MoodPoint[] }) {
  // Show compact squares — scales from 7 to 90 days without wrapping.
  return (
    <div className="ar-mood-grid">
      {timeline.map((p) => {
        const label = p.energy
          ? `${shortDate(p.date)} — ${MOOD_EMOJI[p.energy]} ${p.energy}/5${p.note ? ` · ${p.note}` : ''}`
          : `${shortDate(p.date)} — no log`;
        return (
          <div
            key={p.date}
            className={`ar-mood-square${p.energy ? '' : ' ar-mood-square--empty'}`}
            style={p.energy ? { background: ENERGY_COLOR[p.energy] } : undefined}
            title={label}
          >
            {p.energy ? MOOD_EMOJI[p.energy] : ''}
          </div>
        );
      })}
    </div>
  );
}

function PatternCard({ pattern }: { pattern: DetectedPattern }) {
  return (
    <div className={`ar-pattern ar-pattern--${pattern.severity}`}>
      <span className="ar-pattern__icon" aria-hidden="true">
        {SEVERITY_ICON[pattern.severity]}
      </span>
      <div className="ar-pattern__body">
        <span className="ar-pattern__rule">{pattern.rule}</span>
        <p className="ar-pattern__desc">{pattern.description}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface Props {
  onClose: () => void;
}

export function AiReportPage({ onClose }: Props) {
  const [period, setPeriod] = useState<PeriodType>('30');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ReportData | null>(null);
  const [patterns, setPatterns] = useState<DetectedPattern[]>([]);
  const [generatedFor, setGeneratedFor] = useState<string | null>(null);

  const handleGenerate = useCallback(async () => {
    setLoading(true);
    setError(null);
    setData(null);
    setPatterns([]);

    try {
      const { from, to } = getPeriodDates(period);
      const res = await apiFetch(`/analytics/report-data?from_date=${from}&to_date=${to}`);
      const json: ReportData = await res.json();
      const detected = evaluatePatterns(json.categoryBreakdown, json.moodTimeline);
      setData(json);
      setPatterns(detected);
      setGeneratedFor(`${PERIOD_LABELS[period]} · ${from} → ${to}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load analytics data.');
    } finally {
      setLoading(false);
    }
  }, [period]);

  const maxPct = data ? Math.max(...data.categoryBreakdown.map((b) => b.pct), 1) : 1;

  return (
    <div className="ar-overlay" onClick={onClose}>
      <div className="ar-panel" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="ar-header">
          <h2 className="ar-title">📊 Analytics Report</h2>
          <button className="ar-close" onClick={onClose} title="Close">×</button>
        </div>

        {/* Controls */}
        <div className="ar-controls">
          <select
            className="ar-period-select"
            value={period}
            onChange={(e) => setPeriod(e.target.value as PeriodType)}
          >
            {(Object.entries(PERIOD_LABELS) as [PeriodType, string][]).map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
          <button
            className="ar-generate-btn"
            onClick={handleGenerate}
            disabled={loading}
          >
            {loading ? 'Generating…' : 'Generate'}
          </button>
        </div>

        {/* Error */}
        {error && <div className="ar-error">{error}</div>}

        {/* Empty state */}
        {!data && !loading && !error && (
          <div className="ar-empty">
            Select a period and click Generate to analyse your weekly planner data.
          </div>
        )}

        {/* Results */}
        {data && (
          <div className="ar-results">
            <p className="ar-generated-label">{generatedFor}</p>

            {/* Category breakdown */}
            <section className="ar-section">
              <h3 className="ar-section-title">Category Breakdown</h3>
              {data.categoryBreakdown.length === 0 ? (
                <p className="ar-no-data">No classified todos for this period. Make sure to run classification first.</p>
              ) : (
                <div className="ar-bar-list">
                  {data.categoryBreakdown.map((item) => (
                    <CategoryBar key={item.category} item={item} maxPct={maxPct} />
                  ))}
                </div>
              )}
            </section>

            {/* Mood timeline */}
            <section className="ar-section">
              <h3 className="ar-section-title">Mood Timeline</h3>
              {data.moodTimeline.every((p) => p.energy === null) ? (
                <p className="ar-no-data">No mood logs for this period. Log your energy daily in the weekly planner.</p>
              ) : (
                <>
                  <div className="ar-mood-legend">
                    {([1, 2, 3, 4, 5] as const).map((n) => (
                      <span key={n} className="ar-mood-legend-item">
                        <span
                          className="ar-mood-legend-dot"
                          style={{ background: ENERGY_COLOR[n] }}
                        />
                        {MOOD_EMOJI[n]}
                      </span>
                    ))}
                    <span className="ar-mood-legend-item">
                      <span className="ar-mood-legend-dot ar-mood-legend-dot--empty" />
                      no log
                    </span>
                  </div>
                  <MoodTimeline timeline={data.moodTimeline} />
                </>
              )}
            </section>

            {/* Detected patterns */}
            <section className="ar-section">
              <h3 className="ar-section-title">Detected Patterns</h3>
              {patterns.length === 0 ? (
                <p className="ar-no-data">No patterns detected for this period.</p>
              ) : (
                <div className="ar-pattern-list">
                  {patterns.map((p) => (
                    <PatternCard key={p.rule} pattern={p} />
                  ))}
                </div>
              )}
            </section>

            {/* Phase 3 placeholder */}
            <section className="ar-section ar-section--future">
              <p className="ar-future-hint">
                💡 <strong>Coming in Phase 3:</strong> AI-generated narrative, prediction, and proactive questions based on the data above.
              </p>
            </section>
          </div>
        )}

      </div>
    </div>
  );
}
