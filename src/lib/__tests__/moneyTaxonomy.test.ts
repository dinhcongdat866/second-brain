/**
 * Category names exist in three places that must agree: MONEY_CATEGORIES in
 * backend/app/routers/money.py (what the parser returns and SQL groups on),
 * MONEY_CAT here, and the `moneyCategory.*` block in each locale file.
 *
 * Drift is silent by nature — a category the locale files don't know about
 * still renders, just as a raw English identifier in the middle of Vietnamese
 * UI — so it is worth a test rather than a convention.
 */
import { describe, it, expect } from 'vitest';
import { MONEY_CAT, moneyCategoryLabel } from '../moneyTaxonomy';
import en from '../../i18n/locales/en.json';
import vi from '../../i18n/locales/vi.json';

const LOCALES = { en, vi } as const;

/** Stand-in for i18next's `t`, resolving 'a.b' against a locale object. */
function translator(locale: Record<string, unknown>) {
  return (key: string): string => {
    const value = key.split('.').reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      locale,
    );
    return typeof value === 'string' ? value : key;
  };
}

describe('money category translations', () => {
  const categories = Object.values(MONEY_CAT);

  for (const [name, locale] of Object.entries(LOCALES)) {
    it(`${name} translates every category`, () => {
      const t = translator(locale as Record<string, unknown>);
      const untranslated = categories.filter((c) => moneyCategoryLabel(t, c).startsWith('moneyCategory.'));
      expect(untranslated).toEqual([]);
    });
  }

  it('translates to Vietnamese, not the identifier', () => {
    const t = translator(vi as Record<string, unknown>);
    expect(moneyCategoryLabel(t, MONEY_CAT.FOOD)).toBe('Ăn uống');
    expect(moneyCategoryLabel(t, MONEY_CAT.BORROWING)).toBe('Vay');
  });

  it('falls back to the identifier for a category the frontend does not know yet', () => {
    // The backend can add a category before this table catches up; showing
    // readable English beats showing a missing-translation key.
    const t = translator(vi as Record<string, unknown>);
    expect(moneyCategoryLabel(t, 'Investments')).toBe('Investments');
  });

  it('en and vi define exactly the same category keys', () => {
    const keys = (l: typeof en | typeof vi) =>
      Object.keys((l as { moneyCategory: Record<string, string> }).moneyCategory).sort();
    expect(keys(vi)).toEqual(keys(en));
  });
});
