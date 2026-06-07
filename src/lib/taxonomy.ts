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
