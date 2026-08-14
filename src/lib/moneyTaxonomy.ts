/**
 * Money log — category taxonomy v1.
 *
 * Single source of truth for money category names on the frontend.
 * Must stay in sync with MONEY_CATEGORIES in backend/app/routers/money.py.
 *
 * These are identifiers, not labels: they are what the parser returns, what
 * money_entries.category stores, and what SQL groups on. Nothing displays them
 * raw — moneyCategoryLabel resolves the shown text through i18n, the same split
 * the todo taxonomy uses in taxonomy.ts.
 */
export const MONEY_CAT = {
  FOOD:           'Food & Drink',
  TRANSPORT:      'Transport',
  HOUSING:        'Housing',
  BILLS:          'Bills',
  HEALTH:         'Health',
  ENTERTAINMENT:  'Entertainment',
  SHOPPING:       'Shopping',
  EDUCATION:      'Education',
  SALARY:         'Salary',
  OTHER_INCOME:   'Other Income',
  BORROWING:      'Borrowing',
  DEBT_REPAYMENT: 'Debt Repayment',
  OTHER:          'Other',
  /**
   * Client-generated only. The parser never returns it and the backend has
   * never heard of it: a balance correction is bookkeeping, not something that
   * happened to your money. moneyStats excludes it from every figure, because
   * counting a −200.000 correction as spending would make fixing your wallet
   * look like a shopping trip.
   */
  ADJUSTMENT:     'Balance Adjustment',
} as const;

export type MoneyCategoryName = (typeof MONEY_CAT)[keyof typeof MONEY_CAT];

/** Identifier → i18n key suffix under `moneyCategory.*`. */
const I18N_KEY: Record<string, string> = {
  [MONEY_CAT.FOOD]:           'food',
  [MONEY_CAT.TRANSPORT]:      'transport',
  [MONEY_CAT.HOUSING]:        'housing',
  [MONEY_CAT.BILLS]:          'bills',
  [MONEY_CAT.HEALTH]:         'health',
  [MONEY_CAT.ENTERTAINMENT]:  'entertainment',
  [MONEY_CAT.SHOPPING]:       'shopping',
  [MONEY_CAT.EDUCATION]:      'education',
  [MONEY_CAT.SALARY]:         'salary',
  [MONEY_CAT.OTHER_INCOME]:   'otherIncome',
  [MONEY_CAT.BORROWING]:      'borrowing',
  [MONEY_CAT.DEBT_REPAYMENT]: 'debtRepayment',
  [MONEY_CAT.OTHER]:          'other',
  [MONEY_CAT.ADJUSTMENT]:     'adjustment',
};

/**
 * Display text for a stored category.
 *
 * Falls back to the identifier itself for anything unrecognised, so a category
 * added to the backend before this table shows up as readable English rather
 * than a missing-translation placeholder.
 */
export function moneyCategoryLabel(
  t: (key: string) => string,
  category: string,
): string {
  const key = I18N_KEY[category];
  return key ? t(`moneyCategory.${key}`) : category;
}
