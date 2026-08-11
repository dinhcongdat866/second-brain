import { useEffect } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  src: string;
  onClose: () => void;
}

/**
 * Full-screen view of a single image.
 *
 * Rendered through a portal: the AI cell lives inside a ProseMirror NodeView
 * with its own overflow and stacking context, so an in-place overlay would be
 * clipped by its ancestors.
 */
export function ImageLightbox({ src, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Stop the key here: ProseMirror and the AI cell both listen on window,
      // and Escape should only dismiss the topmost surface.
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="img-lightbox" onClick={onClose} role="dialog" aria-modal="true">
      <button
        type="button"
        className="img-lightbox__close"
        onClick={onClose}
        aria-label="Close"
      >
        ✕
      </button>
      {/* Clicking the image itself must not dismiss — only the backdrop does. */}
      <img
        className="img-lightbox__img"
        src={src}
        alt=""
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  );
}
