import { Plugin, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { resizeImageToBlob } from '../lib/imageResize';
import { uploadImage } from '../lib/backendSync';

function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files).filter((f) => f.type.startsWith('image/'));
}

/** True when the selection sits inside a markdown cell (where a block image fits). */
function inMarkdownCell(view: EditorView): boolean {
  const { $from } = view.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'markdown_cell') return true;
  }
  return false;
}

/** Resize → upload each file, then insert an image node at the selection. */
async function insertUploadedImages(view: EditorView, files: File[], docId: string): Promise<void> {
  for (const file of files) {
    try {
      const blob = await resizeImageToBlob(file);
      const url = await uploadImage(blob, docId);
      if (!url) continue;
      const type = view.state.schema.nodes.image;
      view.dispatch(view.state.tr.replaceSelectionWith(type.create({ src: url })));
    } catch {
      /* unreadable image or failed upload — skip */
    }
  }
}

/**
 * Paste / drop images into a markdown cell. Images are downscaled and uploaded
 * to the backend; only the returned URL goes into the document (never bytes).
 */
export function imagePastePlugin(getDocId: () => string) {
  return new Plugin({
    props: {
      handlePaste(view, event) {
        const files = imageFilesFrom(event.clipboardData);
        if (!files.length || !inMarkdownCell(view)) return false;
        event.preventDefault();
        void insertUploadedImages(view, files, getDocId());
        return true;
      },
      handleDrop(view, event) {
        const files = imageFilesFrom(event.dataTransfer);
        if (!files.length) return false;
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        if (!coords) return false;
        // Move the cursor to the drop point so the image lands there.
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(coords.pos))));
        if (!inMarkdownCell(view)) return false;
        event.preventDefault();
        void insertUploadedImages(view, files, getDocId());
        return true;
      },
    },
  });
}
