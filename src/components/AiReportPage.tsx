/**
 * Analytics Report overlay.
 *
 * Phase 2: SQL data (category breakdown + mood timeline) + client-side pattern rules.
 * Phase 3: AI narrative, prediction, and proactive questions via POST /analytics/report-generate.
 *
 * Two-phase loading: SQL data appears immediately, AI section streams in after.
 * PDF export via window.print() — @media print CSS in ai-report.css.
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

interface AiPrediction {
  text: string;
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
}

interface AiInsights {
  narrative: string;
  prediction: AiPrediction;
  proactiveQuestions: string[];
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

const CONFIDENCE_LABEL: Record<AiPrediction['confidence'], string> = {
  low: 'Low confidence', medium: 'Medium confidence', high: 'High confidence',
};

function shortDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
        <span className={`ar-trend ar-trend--${item.trend}`}>{TREND_ICON[item.trend]}</span>
      </span>
    </div>
  );
}

function MoodTimeline({ timeline }: { timeline: MoodPoint[] }) {
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
      <span className="ar-pattern__icon" aria-hidden="true">{SEVERITY_ICON[pattern.severity]}</span>
      <div className="ar-pattern__body">
        <span className="ar-pattern__rule">{pattern.rule}</span>
        <p className="ar-pattern__desc">{pattern.description}</p>
      </div>
    </div>
  );
}

function AiSection({ insights, loading }: { insights: AiInsights | null; loading: boolean }) {
  if (loading) {
    return (
      <section className="ar-section">
        <h3 className="ar-section-title">AI Insights</h3>
        <div className="ar-ai-loading">
          <span className="ar-ai-loading__spinner" />
          Analysing patterns…
        </div>
      </section>
    );
  }

  if (!insights) return null;

  const { narrative, prediction, proactiveQuestions } = insights;

  return (
    <section className="ar-section">
      <h3 className="ar-section-title">AI Insights</h3>

      {/* Narrative */}
      <p className="ar-narrative">{narrative}</p>

      {/* Prediction */}
      <div className={`ar-prediction ar-prediction--${prediction.confidence}`}>
        <div className="ar-prediction__header">
          <span className="ar-prediction__label">Prediction</span>
          <span className={`ar-prediction__confidence ar-prediction__confidence--${prediction.confidence}`}>
            {CONFIDENCE_LABEL[prediction.confidence]}
          </span>
        </div>
        <p className="ar-prediction__text">{prediction.text}</p>
        <p className="ar-prediction__reasoning">Reasoning: {prediction.reasoning}</p>
      </div>

      {/* Proactive questions */}
      {proactiveQuestions.length > 0 && (
        <div className="ar-questions">
          <span className="ar-questions__label">💬 Questions to consider</span>
          <ul className="ar-questions__list">
            {proactiveQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface Props {
  onClose: () => void;
}

export function AiReportPage({ onClose }: Props) {
  const [period, setPeriod]           = useState<PeriodType>('30');
  const [dataLoading, setDataLoading] = useState(false);
  const [aiLoading, setAiLoading]     = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [data, setData]               = useState<ReportData | null>(null);
  const [patterns, setPatterns]       = useState<DetectedPattern[]>([]);
  const [aiInsights, setAiInsights]   = useState<AiInsights | null>(null);
  const [generatedFor, setGeneratedFor] = useState<string | null>(null);

  const handleGenerate = useCallback(async () => {
    // Reset everything
    setDataLoading(true);
    setAiLoading(false);
    setError(null);
    setData(null);
    setPatterns([]);
    setAiInsights(null);

    const { from, to } = getPeriodDates(period);
    const periodMeta = { type: PERIOD_LABELS[period], start: from, end: to };

    try {
      // ── Phase 1: SQL aggregates (fast) ──────────────────────────────────
      const res = await apiFetch(`/analytics/report-data?from_date=${from}&to_date=${to}`);
      const json: ReportData = await res.json();
      const detected = evaluatePatterns(json.categoryBreakdown, json.moodTimeline);

      setData(json);
      setPatterns(detected);
      setGeneratedFor(`${PERIOD_LABELS[period]} · ${from} → ${to}`);
      setDataLoading(false);

      // ── Phase 2: AI narrative (slower — show spinner while waiting) ─────
      setAiLoading(true);
      const aiRes = await apiFetch('/analytics/report-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period: periodMeta,
          categoryBreakdown: json.categoryBreakdown,
          moodTimeline: json.moodTimeline,
          detectedPatterns: detected,
        }),
      });
      const aiJson: AiInsights = await aiRes.json();
      setAiInsights(aiJson);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate report.');
      setDataLoading(false);
    } finally {
      setAiLoading(false);
    }
  }, [period]);

  const isAnyLoading = dataLoading || aiLoading;
  const maxPct = data ? Math.max(...data.categoryBreakdown.map((b) => b.pct), 1) : 1;
  const showExport = !!data && !!aiInsights;

  return (
    <div className="ar-overlay" onClick={onClose}>
      <div className="ar-panel" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="ar-header">
          <h2 className="ar-title">📊 Analytics Report</h2>
          <div className="ar-header-actions">
            {showExport && (
              <button
                className="ar-export-btn"
                onClick={() => window.print()}
                title="Export as PDF"
              >
                ⬇ Export PDF
              </button>
            )}
            <button className="ar-close" onClick={onClose} title="Close">×</button>
          </div>
        </div>

        {/* Controls */}
        <div className="ar-controls">
          <select
            className="ar-period-select"
            value={period}
            onChange={(e) => setPeriod(e.target.value as PeriodType)}
            disabled={isAnyLoading}
          >
            {(Object.entries(PERIOD_LABELS) as [PeriodType, string][]).map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
          <button
            className="ar-generate-btn"
            onClick={handleGenerate}
            disabled={isAnyLoading}
          >
            {dataLoading ? 'Loading data…' : aiLoading ? 'Asking AI…' : 'Generate'}
          </button>
        </div>

        {/* Error */}
        {error && <div className="ar-error">{error}</div>}

        {/* Empty state */}
        {!data && !isAnyLoading && !error && (
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
                <p className="ar-no-data">No classified todos for this period. Run classification first.</p>
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
                        <span className="ar-mood-legend-dot" style={{ background: ENERGY_COLOR[n] }} />
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
                  {patterns.map((p) => <PatternCard key={p.rule} pattern={p} />)}
                </div>
              )}
            </section>

            {/* AI Insights (phase 3) */}
            <AiSection insights={aiInsights} loading={aiLoading} />

          </div>
        )}

      </div>
    </div>
  );
}
