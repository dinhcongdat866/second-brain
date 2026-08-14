/**
 * Personal Analytics — category taxonomy v2.
 *
 * Single source of truth for category names on the frontend.
 * Must stay in sync with CATEGORIES dict in backend/app/routers/analytics.py.
 *
 * v1 → v2: renamed "Tìm việc" → "Job Search", "Công việc" → "Work",
 *           "Tài chính" → "Finance".
 */
export const CAT = {
  MENTAL_WORK:       'Mental Work',
  JOB_SEARCH:        'Job Search',
  WORK:              'Work',
  PERSONAL_PROJECT:  'Personal Project',
  FINANCE:           'Finance',
  RELATIONSHIPS:     'Relationships',
  REST:              'Rest',
  LEISURE:           'Leisure',
  CHORES:            'Chores',
  BAD_MENTAL_HEALTH: 'Bad mental health',
  BAD_PHYSICAL:      'Bad physical health',
} as const;

export type CategoryName = (typeof CAT)[keyof typeof CAT];

/** Identifier → i18n key suffix under `todoCategory.*`. */
const I18N_KEY: Record<string, string> = {
  [CAT.MENTAL_WORK]:       'mentalWork',
  [CAT.JOB_SEARCH]:        'jobSearch',
  [CAT.WORK]:              'work',
  [CAT.PERSONAL_PROJECT]:  'personalProject',
  [CAT.FINANCE]:           'finance',
  [CAT.RELATIONSHIPS]:     'relationships',
  [CAT.REST]:              'rest',
  [CAT.LEISURE]:           'leisure',
  [CAT.CHORES]:            'chores',
  [CAT.BAD_MENTAL_HEALTH]: 'badMentalHealth',
  [CAT.BAD_PHYSICAL]:      'badPhysical',
};

/**
 * Display text for a stored category — the same identifier/label split
 * moneyCategoryLabel uses, and for the same reason: these strings are what the
 * classifier returns and what todo_classifications stores, so translating them
 * at the point of storage would make the data language-dependent.
 *
 * Falls back to the identifier for anything unrecognised, so a category added
 * to the backend before this table shows up as readable English rather than a
 * missing-translation placeholder.
 */
export function categoryLabel(
  t: (key: string) => string,
  category: string,
): string {
  const key = I18N_KEY[category];
  return key ? t(`todoCategory.${key}`) : category;
}
