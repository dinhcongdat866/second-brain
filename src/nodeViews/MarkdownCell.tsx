import { useState } from 'react';
import { formatSmartDate, formatFullDate } from '../lib/formatDate';

function IconCopy() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function MarkdownCellControls({
  createdAt,
  getContent,
}: {
  createdAt: string;
  getContent: () => string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    const text = getContent().trim();
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    // onMouseDown prevents focus from leaving the PM editor when clicking controls
    <div className="md-cell-controls" onMouseDown={(e) => e.preventDefault()}>
      {createdAt && (
        <span
          className="md-cell-controls__time"
          title={formatFullDate(createdAt)}
        >
          {formatSmartDate(createdAt)}
        </span>
      )}
      <button
        type="button"
        className="md-cell-controls__btn"
        onClick={copy}
        title="Copy nội dung cell"
      >
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
    </div>
  );
}
