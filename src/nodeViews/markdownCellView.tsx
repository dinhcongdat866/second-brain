import { createRoot, type Root } from 'react-dom/client';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import { MarkdownCellControls } from './MarkdownCell';

// ---------------------------------------------------------------------------
// MarkdownCellView — NodeView for markdown_cell nodes.
//
// Uses the sibling pattern: `dom` contains two siblings —
//   • contentDOM  — ProseMirror owns this (renders paragraphs, headings, etc.)
//   • reactHost   — React owns this (Copy button + created_at timestamp)
//
// The split means React and PM never fight over DOM ownership.
// ---------------------------------------------------------------------------

export class MarkdownCellView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private reactHost: HTMLElement;
  private root: Root;

  constructor(node: PMNode, _view: EditorView, _getPos: () => number | undefined) {
    this.dom = document.createElement('div');
    this.dom.setAttribute('data-type', 'markdown-cell');
    this.dom.setAttribute('data-id', node.attrs.id as string);

    // ProseMirror renders cell content (paragraphs, headings…) here
    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'markdown-cell__content';

    // React renders the hover controls here (outside PM's reach)
    this.reactHost = document.createElement('div');
    this.reactHost.className = 'markdown-cell__controls';

    this.dom.appendChild(this.contentDOM);
    this.dom.appendChild(this.reactHost);

    this.root = createRoot(this.reactHost);
    this.renderControls(node);
  }

  private renderControls(node: PMNode) {
    const createdAt = node.attrs.created_at as string ?? '';
    // getContent reads the live text out of contentDOM at copy-time
    const getContent = () => this.contentDOM.innerText;
    this.root.render(
      <MarkdownCellControls createdAt={createdAt} getContent={getContent} />,
    );
  }

  update(node: PMNode) {
    if (node.type.name !== 'markdown_cell') return false;
    this.renderControls(node);
    return true;
  }

  /**
   * ProseMirror calls this for every DOM mutation it detects inside `dom`.
   * Return true to tell PM "ignore this — it's not a user edit."
   *
   * Without this, React re-rendering the controls div causes PM to see a
   * "mutation", attempt to re-read the document, dispatch a transaction,
   * call update() → root.render() → more mutations → infinite loop / freeze.
   */
  ignoreMutation(mutation: MutationRecord | { type: 'selection' }): boolean {
    // Let PM handle selection changes normally (cursor movement etc.)
    if (mutation.type === 'selection') return false;
    // Ignore any mutation that originates inside the React-owned controls host
    return this.reactHost.contains((mutation as MutationRecord).target);
  }

  destroy() {
    const root = this.root;
    queueMicrotask(() => root.unmount());
  }
}
