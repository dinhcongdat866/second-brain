import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import { fetchShare, setShare, shareUrl, type LinkAccess } from '../lib/sharing';

interface Props {
  docId: string;
  docName: string;
  onClose: () => void;
}

const LEVELS: LinkAccess[] = ['none', 'read', 'write'];

export function ShareModal({ docId, docName, onClose }: Props) {
  const { t } = useTranslation();
  const [access, setAccess] = useState<LinkAccess | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchShare(docId)
      .then((s) => { if (!cancelled) setAccess(s?.linkAccess ?? 'none'); })
      // Never published, or the backend is unreachable. Either way the honest
      // starting point is "not shared" — the modal must not open pre-set to
      // something the server has not agreed to.
      .catch(() => { if (!cancelled) setAccess('none'); });
    return () => { cancelled = true; };
  }, [docId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const choose = async (next: LinkAccess) => {
    if (next === access || saving) return;
    const previous = access;
    setAccess(next);
    setSaving(true);
    setError(null);
    try {
      await setShare(docId, next, docName);
    } catch (err) {
      // Put the radio back where the server still has it. A control that stays
      // switched after a failed save is a lie about who can read this.
      setAccess(previous);
      setError(
        err instanceof Error && 'status' in err && (err as { status: number }).status === 409
          ? t('share.errorDuplicateId')
          : t('share.errorSave'),
      );
    } finally {
      setSaving(false);
    }
  };

  const url = shareUrl(docId);
  const isPublic = access === 'read' || access === 'write';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError(t('share.errorCopy'));
    }
  };

  return createPortal(
    <div className="share-overlay" onClick={onClose}>
      <div
        className="share-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('share.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="share-modal__head">
          <h2>{t('share.title')}</h2>
          <button type="button" className="share-modal__close" onClick={onClose} aria-label={t('share.close')}>
            <Icon name="close" />
          </button>
        </div>

        <p className="share-modal__doc">{docName || t('share.untitled')}</p>

        {access === null ? (
          <p className="share-modal__loading">{t('app.loading')}</p>
        ) : (
          <>
            <div className="share-levels" role="radiogroup" aria-label={t('share.title')}>
              {LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={access === level}
                  className={`share-level${access === level ? ' share-level--on' : ''}`}
                  onClick={() => void choose(level)}
                  disabled={saving}
                >
                  <span className="share-level__dot" aria-hidden="true" />
                  <span className="share-level__text">
                    <span className="share-level__name">{t(`share.level.${level}.name`)}</span>
                    <span className="share-level__hint">{t(`share.level.${level}.hint`)}</span>
                  </span>
                </button>
              ))}
            </div>

            {isPublic && (
              <div className="share-link">
                <input className="share-link__url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="share-link__copy" onClick={() => void copy()}>
                  {copied ? t('share.copied') : t('share.copy')}
                </button>
              </div>
            )}

            {/* Said plainly and only when it applies. The three cells read the
                viewer, not the author, so they are withdrawn from shared pages
                — better to say so here than to let it be discovered. */}
            {isPublic && <p className="share-modal__note">{t('share.personalNote')}</p>}
          </>
        )}

        {error && <p className="share-modal__error">{error}</p>}
      </div>
    </div>,
    document.body,
  );
}
