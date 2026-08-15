/**
 * The classification sync, now that it writes results back into the Y.Doc.
 * Two hazards: a todo the database has already classified must not be sent to
 * the model again just because the Y.Doc has no copy yet (that is the state on
 * every first load after this change, for every todo ever written), and the
 * answer has to land in the Y.Doc by both routes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';

vi.mock('../../lib/http', () => ({ apiFetch: vi.fn() }));
vi.mock('../../lib/apiKey', () => ({ getApiKey: () => 'sk-test' }));

import { apiFetch } from '../../lib/http';
import {
  SHARED_PLAN_ID,
  addTodo,
  getMondayOf,
  getWeeklyPlan,
  readAllDays,
} from '../../collab/weeklyPlans';
import { syncClassificationsForTest } from '../useClassificationSync';

const apiFetchMock = vi.mocked(apiFetch);
const WEEK = getMondayOf(new Date());

const jsonResponse = (body: unknown) => ({ json: async () => body }) as unknown as Response;
const calledPaths = () => apiFetchMock.mock.calls.map((c) => String(c[0]).split('?')[0]);

/** A row as GET /analytics/classifications returns it. */
function storedRow(todoId: string, text: string, categories: string[]) {
  return { todo_id: todoId, categories, todo_text: text, taxonomy_version: 3 };
}

function planWith(...texts: string[]) {
  const ydoc = new Y.Doc();
  const plan = getWeeklyPlan(ydoc, SHARED_PLAN_ID);
  for (const text of texts) addTodo(plan, WEEK, 'mon', text);
  return { ydoc, plan, ids: readAllDays(plan, WEEK).mon.map((t) => t.id) };
}

const monCategories = (plan: Y.Map<unknown>) =>
  readAllDays(plan, WEEK).mon.map((t) => t.categories);

/** Put categories on a todo the way a previous sync would have left them. */
function stampCategories(plan: Y.Map<unknown>, index: number, categories: string[]) {
  const week = (plan.get('weeks') as Y.Map<unknown>).get(WEEK) as Y.Map<unknown>;
  (week.get('mon') as Y.Array<Y.Map<unknown>>).get(index).set('categories', categories);
}

beforeEach(() => { apiFetchMock.mockReset(); });

describe('a classification the database already holds', () => {
  it('is copied into the Y.Doc without calling the model', async () => {
    const { ydoc, plan, ids } = planWith('Nộp CV cho Grab');

    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/analytics/classifications')) {
        return jsonResponse([storedRow(ids[0], 'Nộp CV cho Grab', ['Job Search'])]);
      }
      throw new Error(`unexpected call: ${path}`);
    });

    await syncClassificationsForTest(ydoc);

    expect(monCategories(plan)).toEqual([['Job Search']]);
    expect(calledPaths()).not.toContain('/analytics/classify');
  });

  it('is left alone when the Y.Doc already agrees, in any order', async () => {
    // The classifier promises no order; comparing positionally would rewrite
    // every two-category todo on every load.
    const { ydoc, plan, ids } = planWith('Ăn cưới');
    stampCategories(plan, 0, ['Leisure', 'Relationships']);

    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/analytics/classifications')) {
        return jsonResponse([storedRow(ids[0], 'Ăn cưới', ['Relationships', 'Leisure'])]);
      }
      throw new Error(`unexpected call: ${path}`);
    });

    await syncClassificationsForTest(ydoc);

    expect(monCategories(plan)).toEqual([['Leisure', 'Relationships']]);
    expect(calledPaths()).not.toContain('/analytics/classify');
  });
});

describe('a todo the database has not seen', () => {
  it('is classified once and the answer lands in the Y.Doc', async () => {
    const { ydoc, plan, ids } = planWith('Sửa bug loading');

    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/analytics/classifications')) return jsonResponse([]);
      if (path === '/analytics/classify') {
        return jsonResponse({ results: [{ todo_id: ids[0], categories: ['Personal Project'] }] });
      }
      throw new Error(`unexpected call: ${path}`);
    });

    await syncClassificationsForTest(ydoc);

    expect(monCategories(plan)).toEqual([['Personal Project']]);
    expect(calledPaths().filter((p) => p === '/analytics/classify')).toHaveLength(1);
  });

  it('sends only the wire fields, never the Y.Map handle', async () => {
    // The Y.Map handle must not reach JSON.stringify.
    const { ydoc, ids } = planWith('Sửa bug loading');

    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/analytics/classifications')) return jsonResponse([]);
      return jsonResponse({ results: [{ todo_id: ids[0], categories: ['Work'] }] });
    });

    await syncClassificationsForTest(ydoc);

    const classifyCall = apiFetchMock.mock.calls.find((c) => c[0] === '/analytics/classify')!;
    const body = JSON.parse(String((classifyCall[1] as RequestInit).body));
    expect(Object.keys(body.todos[0]).sort()).toEqual(['text', 'todo_id', 'week_start']);
  });

  it('re-classifies when the text changed since last time', async () => {
    const { ydoc, plan, ids } = planWith('Nộp CV');

    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/analytics/classifications')) {
        // The stored row describes an older wording.
        return jsonResponse([storedRow(ids[0], 'Chơi game', ['Leisure'])]);
      }
      return jsonResponse({ results: [{ todo_id: ids[0], categories: ['Job Search'] }] });
    });

    await syncClassificationsForTest(ydoc);

    expect(monCategories(plan)).toEqual([['Job Search']]);
  });

  it('re-classifies when the stored row is on an older taxonomy', async () => {
    const { ydoc, plan, ids } = planWith('Nộp CV');

    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/analytics/classifications')) {
        return jsonResponse([{ ...storedRow(ids[0], 'Nộp CV', ['Chores']), taxonomy_version: 1 }]);
      }
      return jsonResponse({ results: [{ todo_id: ids[0], categories: ['Job Search'] }] });
    });

    await syncClassificationsForTest(ydoc);

    expect(monCategories(plan)).toEqual([['Job Search']]);
  });
});

describe('nothing to do', () => {
  it('makes no request at all when there are no todos', async () => {
    const ydoc = new Y.Doc();
    getWeeklyPlan(ydoc, SHARED_PLAN_ID);
    await syncClassificationsForTest(ydoc);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
