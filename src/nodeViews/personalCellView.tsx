import type { Node as PMNode } from 'prosemirror-model';
import type { NodeView } from 'prosemirror-view';
import i18n from '../i18n';

/**
 * Stands in for the AI, planner and money cells inside a document you are
 * reading through a share link.
 *
 * They are not hidden because they are secret — the author's words are right
 * there. They are withdrawn because they are not the author's: all three read
 * whoever is looking, so in a shared page they would render your planner and
 * spend your API key while appearing to be part of someone else's document.
 *
 * A visible plaque rather than nothing, so the page does not look truncated.
 */
export class PersonalCellView implements NodeView {
  dom: HTMLElement;

  constructor(node: PMNode) {
    this.dom = document.createElement('div');
    this.dom.className = 'personal-cell';
    this.dom.textContent = i18n.t(`share.personalCell.${node.type.name}`, {
      defaultValue: i18n.t('share.personalCell.generic'),
    });
  }

  stopEvent() {
    return true;
  }

  ignoreMutation() {
    return true;
  }
}
