import { useState, useEffect, useRef, type KeyboardEvent } from 'react';
import type * as Y from 'yjs';
import {
  DAY_KEYS,
  DAY_LABELS,
  type DayKey,
  type AllDays,
  addTodo,
  toggleTodo,
  deleteTodo,
  readAllDays,
  weekRangeLabel,
  todayDayKey,
} from '../collab/weeklyPlans';

interface Props {
  plan: Y.Map<unknown>;
  onDelete: () => void;
}

interface DayColumnProps {
  day: DayKey;
  todos: AllDays[DayKey];
  isToday: boolean;
  plan: Y.Map<unknown>;
}

function DayColumn({ day, todos, isToday, plan }: DayColumnProps) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Prevent ProseMirror from intercepting keystrokes inside the NodeView.
    e.stopPropagation();
    if (e.key === 'Enter' && input.trim()) {
      addTodo(plan, day, input);
      setInput('');
    }
  };

  return (
    <div className={`weekly-day${isToday ? ' weekly-day--today' : ''}`}>
      <div className="weekly-day__header">{DAY_LABELS[day]}</div>
      <div className="weekly-day__todos">
        {todos.map((todo) => (
          <div key={todo.id} className="weekly-todo">
            <input
              type="checkbox"
              className="weekly-todo__check"
              checked={todo.done}
              onChange={() => toggleTodo(plan, day, todo.id)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <span className={`weekly-todo__text${todo.done ? ' weekly-todo__text--done' : ''}`}>
              {todo.text}
            </span>
            <button
              type="button"
              className="weekly-todo__del"
              onClick={() => deleteTodo(plan, day, todo.id)}
              title="Delete"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <input
        ref={inputRef}
        className="weekly-day__input"
        placeholder="Add…"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

export function WeeklyPlannerCell({ plan, onDelete }: Props) {
  const [days, setDays] = useState<AllDays>(() => readAllDays(plan));
  const weekStart = plan.get('weekStart') as string;
  const todayKey = todayDayKey(weekStart);

  useEffect(() => {
    const handler = () => setDays(readAllDays(plan));
    plan.observeDeep(handler);
    return () => plan.unobserveDeep(handler);
  }, [plan]);

  return (
    <div className="weekly-cell">
      <div className="weekly-cell__header">
        <span className="weekly-cell__title">📅 {weekRangeLabel(weekStart)}</span>
        <button
          type="button"
          className="weekly-cell__delete"
          onClick={onDelete}
          title="Delete cell"
        >
          ×
        </button>
      </div>
      <div className="weekly-cell__grid">
        {DAY_KEYS.map((day) => (
          <DayColumn
            key={day}
            day={day}
            todos={days[day]}
            isToday={todayKey === day}
            plan={plan}
          />
        ))}
      </div>
    </div>
  );
}
