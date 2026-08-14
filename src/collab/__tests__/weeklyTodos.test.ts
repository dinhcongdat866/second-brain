/**
 * Editing an existing todo.
 *
 * The stored string is raw source — `**bold**`, `{c=…}` markers and all — so an
 * edit round-trips that source rather than the rendered text; anything else
 * would silently strip formatting the moment you fixed a typo.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  SHARED_PLAN_ID,
  addTodo,
  dayToDate,
  getDayList,
  getWeeklyPlan,
  readAllDays,
  readTodoCategoriesByDate,
  updateTodoText,
  type DayKey,
} from '../weeklyPlans';

const WEEK = '2026-08-10';

function planWithTodos(...texts: string[]) {
  const ydoc = new Y.Doc();
  const plan = getWeeklyPlan(ydoc, SHARED_PLAN_ID);
  for (const text of texts) addTodo(plan, WEEK, 'mon', text);
  return { ydoc, plan };
}

const monTexts = (plan: Y.Map<unknown>) => readAllDays(plan, WEEK).mon.map((t) => t.text);

describe('updateTodoText', () => {
  it('replaces the text of one todo, leaving the others alone', () => {
    const { plan } = planWithTodos('Sửa bug loading', 'Deploy backend');
    const id = readAllDays(plan, WEEK).mon[0].id;

    updateTodoText(plan, WEEK, 'mon', id, 'Sửa bug loading (xong)');

    expect(monTexts(plan)).toEqual(['Sửa bug loading (xong)', 'Deploy backend']);
  });

  it('keeps id and done state — editing text is not re-creating the todo', () => {
    const { plan } = planWithTodos('Ôn phỏng vấn');
    const before = readAllDays(plan, WEEK).mon[0];

    updateTodoText(plan, WEEK, 'mon', before.id, 'Ôn phỏng vấn Grab');

    const after = readAllDays(plan, WEEK).mon[0];
    expect(after.id).toBe(before.id);
    expect(after.done).toBe(before.done);
  });

  it('round-trips markup, so a typo fix does not strip formatting', () => {
    const raw = '{c=#ff0000}Deadline{/c} **thứ sáu**';
    const { plan } = planWithTodos(raw);
    const id = readAllDays(plan, WEEK).mon[0].id;

    updateTodoText(plan, WEEK, 'mon', id, raw.replace('sáu', 'bảy'));

    expect(monTexts(plan)).toEqual(['{c=#ff0000}Deadline{/c} **thứ bảy**']);
  });

  it('trims, like addTodo does', () => {
    const { plan } = planWithTodos('Deploy');
    const id = readAllDays(plan, WEEK).mon[0].id;

    updateTodoText(plan, WEEK, 'mon', id, '   Deploy backend   ');

    expect(monTexts(plan)).toEqual(['Deploy backend']);
  });

  it('ignores an empty result rather than deleting the todo', () => {
    // The input opens fully selected, so one stray keystroke empties it. Losing
    // the line to that is not worth the shortcut — there is an explicit × button.
    const { plan } = planWithTodos('Viết money_cell');
    const id = readAllDays(plan, WEEK).mon[0].id;

    updateTodoText(plan, WEEK, 'mon', id, '   ');

    expect(monTexts(plan)).toEqual(['Viết money_cell']);
  });

  it('is a no-op for an id that is not in this day', () => {
    const { plan } = planWithTodos('Deploy backend');

    updateTodoText(plan, WEEK, 'tue', 'no-such-id', 'whatever');
    updateTodoText(plan, WEEK, 'mon', 'no-such-id', 'whatever');

    expect(monTexts(plan)).toEqual(['Deploy backend']);
  });

  it('two devices editing different todos both keep their edit', () => {
    const { ydoc, plan } = planWithTodos('Sửa bug loading', 'Deploy backend');
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    const peerPlan = getWeeklyPlan(peer, SHARED_PLAN_ID);

    const [first, second] = readAllDays(plan, WEEK).mon;
    updateTodoText(plan, WEEK, 'mon', first.id, 'Sửa bug loading (xong)');
    updateTodoText(peerPlan, WEEK, 'mon', second.id, 'Deploy backend (xong)');

    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer));

    expect(monTexts(plan)).toEqual(['Sửa bug loading (xong)', 'Deploy backend (xong)']);
    expect(monTexts(peerPlan)).toEqual(monTexts(plan));
  });
});

describe('readTodoCategoriesByDate', () => {
  /** Stamp categories the way useClassificationSync does, straight onto the todo. */
  function classify(plan: Y.Map<unknown>, week: string, day: DayKey, idx: number, cats: string[]) {
    const list = getDayList(plan, week, day);
    list.get(idx).set('categories', cats);
  }

  it('maps a todo to the date of its column, not the start of its week', () => {
    // The join the money cell depends on. Classifications are stored per week
    // in Postgres; spending happens on a day. Getting this wrong would smear a
    // Friday's category across the Monday's spending.
    const ydoc = new Y.Doc();
    const plan = getWeeklyPlan(ydoc, SHARED_PLAN_ID);
    addTodo(plan, WEEK, 'fri', 'Gặp Tuấn');
    classify(plan, WEEK, 'fri', 0, ['Relationships']);

    const byDate = readTodoCategoriesByDate(ydoc);
    expect([...byDate.keys()]).toEqual([dayToDate(WEEK, 'fri')]);
    expect(byDate.get(dayToDate(WEEK, 'fri'))).toEqual(['Relationships']);
  });

  it('takes the union of the day, without repeating a category', () => {
    const ydoc = new Y.Doc();
    const plan = getWeeklyPlan(ydoc, SHARED_PLAN_ID);
    addTodo(plan, WEEK, 'mon', 'Gặp Tuấn');
    addTodo(plan, WEEK, 'mon', 'Ăn cưới');
    addTodo(plan, WEEK, 'mon', 'Sửa bug');
    classify(plan, WEEK, 'mon', 0, ['Relationships']);
    classify(plan, WEEK, 'mon', 1, ['Relationships', 'Leisure']);
    classify(plan, WEEK, 'mon', 2, ['Work']);

    const cats = readTodoCategoriesByDate(ydoc).get(dayToDate(WEEK, 'mon'))!;
    expect([...cats].sort()).toEqual(['Leisure', 'Relationships', 'Work']);
  });

  it('leaves out a day whose todos have not been classified yet', () => {
    // Absent means unknown, not uncategorised. A day that shows up with an
    // empty list would be counted as observed and quietly skew the medians.
    const ydoc = new Y.Doc();
    const plan = getWeeklyPlan(ydoc, SHARED_PLAN_ID);
    addTodo(plan, WEEK, 'tue', 'Chưa phân loại');
    expect(readTodoCategoriesByDate(ydoc).size).toBe(0);
  });

  it('reads categories back through readAllDays', () => {
    const ydoc = new Y.Doc();
    const plan = getWeeklyPlan(ydoc, SHARED_PLAN_ID);
    addTodo(plan, WEEK, 'wed', 'Nộp CV');
    classify(plan, WEEK, 'wed', 0, ['Job Search']);
    expect(readAllDays(plan, WEEK).wed[0].categories).toEqual(['Job Search']);
    // A todo written before categories existed reads as empty, not undefined.
    addTodo(plan, WEEK, 'wed', 'Chưa có');
    expect(readAllDays(plan, WEEK).wed[1].categories).toEqual([]);
  });
});
