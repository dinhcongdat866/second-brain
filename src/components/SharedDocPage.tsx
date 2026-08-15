import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import { FloatingToolbar } from './FloatingToolbar';
import { SlashMenu } from './SlashMenu';
import { useNotebookEditor, type DocSource } from '../hooks/useNotebookEditor';
import { nullPlannerHandle } from '../collab/plannerHandle';

interface Props {
  docId: string;
  ownerId: string;
  canWrite: boolean;
  /** Copied from the owner's registry when they published. May be empty. */
  name: string;
  /** Shown only when there is somewhere to go back to. */
  onLeave?: () => void;
}

/**
 * Somebody else's document, opened by link.
 *
 * Deliberately its own page rather than a mode inside App: almost none of the
 * app chrome applies here. There is no registry to list, no history to travel,
 * no background to set and nothing to export — those all belong to the person
 * whose document this is, and half of them would 403 anyway.
 */
export function SharedDocPage({ docId, ownerId, canWrite, name, onLeave }: Props) {
  const { t } = useTranslation();
  const editorRef = useRef<HTMLDivElement>(null);

  // Identity matters: useNotebookEditor lists it as a dependency, so a fresh
  // object every render would tear the document down and refetch it on a loop.
  const source = useMemo<DocSource>(
    () => ({ ownerId, shared: true, readOnly: !canWrite }),
    [ownerId, canWrite],
  );

  const { view } = useNotebookEditor(
    editorRef,
    docId,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    nullPlannerHandle,
    source,
  );

  return (
    <div className="app shared-page">
      <header className="app-header">
        {onLeave && (
          <button type="button" className="shared-page__back" onClick={onLeave}>
            <Icon name="menu" />
            {t('share.backToMine')}
          </button>
        )}
        <h1>{name || t('share.untitled')}</h1>
        <span className={`shared-badge shared-badge--${canWrite ? 'write' : 'read'}`}>
          {canWrite ? t('share.badgeWrite') : t('share.badgeRead')}
        </span>
      </header>

      <div className="app-body">
        <main className="app-main">
          <div className="notebook-wrap" style={{ width: 960, maxWidth: '100%' }}>
            <div ref={editorRef} className="notebook-editor" />
            {!view && (
              <div className="notebook-loading" role="status">
                <span className="notebook-loading__spinner" aria-hidden="true" />
                {t('app.loading')}
              </div>
            )}
          </div>
          {canWrite && <SlashMenu view={view} />}
          {canWrite && <FloatingToolbar view={view} />}
        </main>
      </div>
    </div>
  );
}

/** Shown for an id that names nothing you are allowed to see. */
export function DocNotFoundPage({ onLeave }: { onLeave?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="doc-missing">
      <h1>{t('share.missingTitle')}</h1>
      <p>{t('share.missingBody')}</p>
      {onLeave && (
        <button type="button" className="doc-missing__action" onClick={onLeave}>
          {t('share.backToMine')}
        </button>
      )}
    </div>
  );
}
