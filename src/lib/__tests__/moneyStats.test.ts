/**
 * The money cell's figures, which are the part of this feature a person will
 * act on. A layout bug is visible; a projection that quietly double-counts rent
 * is not, so the cases below are mostly about the specific ways a plausible
 * implementation gets a number wrong.
 */
import { describe, it, expect } from 'vitest';
import type { MoneyEntryData } from '../../collab/weeklyPlans';
import { MONEY_CAT } from '../moneyTaxonomy';
import {
  addMonths,
  allowance,
  anomalies,
  categoryBreakdown,
  categoryNorms,
  daysElapsedIn,
  daysInMonth,
  detectRecurring,
  estimateNextMonth,
  forecastMonth,
  formatDongCompact,
  ledgerFrom,
  median,
  monthTotals,
  parseDongShorthand,
  searchEntries,
  spendByMood,
  spendByWeekday,
} from '../moneyStats';

let seq = 0;

function entry(
  date: string,
  text: string,
  amount: number | null,
  category: string = MONEY_CAT.OTHER,
  extra: Partial<MoneyEntryData> = {},
): MoneyEntryData {
  return {
    id: `e${seq++}`,
    date,
    text,
    amount,
    category,
    counterparty: null,
    debtDelta: 0,
    status: amount === null ? 'needs_amount' : 'ok',
    parsedFrom: text,
    walletId: null,
    createdAt: seq,
    ...extra,
  };
}

describe('formatDongCompact', () => {
  it('writes amounts the way they were typed', () => {
    expect(formatDongCompact(300_000)).toBe('300k');
    expect(formatDongCompact(6_000_000)).toBe('6tr');
    expect(formatDongCompact(3_800_000)).toBe('3tr8');
    expect(formatDongCompact(-85_000)).toBe('−85k');
    expect(formatDongCompact(0)).toBe('0');
  });

  it('carries a rounded tenth instead of printing "3tr10"', () => {
    expect(formatDongCompact(3_950_000)).toBe('4tr');
    expect(formatDongCompact(999_600)).toBe('1tr');
  });

  it('uses a comma for the tỷ decimal, and drops a trailing zero', () => {
    expect(formatDongCompact(1_250_000_000)).toBe('1,3 tỷ');
    expect(formatDongCompact(2_000_000_000)).toBe('2 tỷ');
  });
});

describe('parseDongShorthand', () => {
  it('reads the units', () => {
    expect(parseDongShorthand('85k')).toBe(85_000);
    expect(parseDongShorthand('5tr')).toBe(5_000_000);
    expect(parseDongShorthand('5 củ')).toBe(5_000_000);
    expect(parseDongShorthand('2 tỷ')).toBe(2_000_000_000);
    expect(parseDongShorthand('1 lít')).toBe(100_000);
  });

  it('reads the compound form, where the tail is a fraction of the unit', () => {
    expect(parseDongShorthand('4tr5')).toBe(4_500_000);
    expect(parseDongShorthand('1tr2')).toBe(1_200_000);
    expect(parseDongShorthand('4tr25')).toBe(4_250_000);
  });

  it('treats dots in a bare number as thousands separators, not decimals', () => {
    // Nobody logs 3.8 đồng, so '3.800.000' is three million eight hundred
    // thousand — reading it as a decimal would be off by a factor of a million.
    expect(parseDongShorthand('3.800.000')).toBe(3_800_000);
    expect(parseDongShorthand('3800000')).toBe(3_800_000);
  });

  it('refuses what it cannot read rather than guessing', () => {
    expect(parseDongShorthand('')).toBeNull();
    expect(parseDongShorthand('mấy chục')).toBeNull();
    expect(parseDongShorthand('85k đồng nữa')).toBeNull();
  });

  it('keeps a leading minus', () => {
    expect(parseDongShorthand('-2tr')).toBe(-2_000_000);
  });
});

describe('median', () => {
  it('is not the mean — one outlier does not move it', () => {
    expect(median([100, 200, 300])).toBe(200);
    expect(median([100, 200, 300, 20_000_000])).toBe(250);
    expect(median([])).toBe(0);
  });
});

describe('dates', () => {
  it('crosses the year boundary', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });

  it('knows February in a leap year', () => {
    expect(daysInMonth('2024-02')).toBe(29);
    expect(daysInMonth('2026-02')).toBe(28);
  });

  it('counts a past month whole and a future month as not started', () => {
    expect(daysElapsedIn('2026-07', '2026-08-14')).toBe(31);
    expect(daysElapsedIn('2026-08', '2026-08-14')).toBe(14);
    expect(daysElapsedIn('2026-09', '2026-08-14')).toBe(0);
  });
});

describe('monthTotals', () => {
  const all = [
    entry('2026-08-01', 'lương', 20_000_000, MONEY_CAT.SALARY),
    entry('2026-08-02', 'cà phê', -85_000, MONEY_CAT.FOOD),
    entry('2026-08-03', 'chưa đọc được', null, MONEY_CAT.OTHER),
    entry('2026-07-30', 'tháng trước', -500_000, MONEY_CAT.FOOD),
  ];

  it('splits in and out by sign and stays inside the month', () => {
    const t = monthTotals(all, '2026-08');
    expect(t.in).toBe(20_000_000);
    expect(t.out).toBe(85_000);
    expect(t.net).toBe(19_915_000);
  });

  it('counts the lines with no amount rather than silently dropping them', () => {
    // The figure is understated while these are outstanding, and the UI says so
    // — the same rule the planner's day total follows.
    expect(monthTotals(all, '2026-08').unknown).toBe(1);
  });

  it('ignores balance corrections', () => {
    const withFix = [...all, entry('2026-08-05', 'Chỉnh số dư', -2_000_000, MONEY_CAT.ADJUSTMENT)];
    // Fixing a wallet must not look like a 2 triệu shopping trip.
    expect(monthTotals(withFix, '2026-08').out).toBe(85_000);
  });
});

describe('categoryBreakdown', () => {
  const all = [
    entry('2026-06-01', 'trọ', -3_000_000, MONEY_CAT.HOUSING),
    entry('2026-06-05', 'ăn', -2_800_000, MONEY_CAT.FOOD),
    entry('2026-07-01', 'trọ', -3_000_000, MONEY_CAT.HOUSING),
    entry('2026-07-05', 'ăn', -2_800_000, MONEY_CAT.FOOD),
    entry('2026-08-01', 'trọ', -3_000_000, MONEY_CAT.HOUSING),
    entry('2026-08-05', 'ăn', -4_200_000, MONEY_CAT.FOOD),
    entry('2026-08-06', 'grab', -300_000, MONEY_CAT.TRANSPORT),
  ];
  const today = '2026-08-14';

  it('sorts by size and reports each share', () => {
    const rows = categoryBreakdown(all, '2026-08', categoryNorms(all, today));
    expect(rows.map((r) => r.category)).toEqual([
      MONEY_CAT.FOOD, MONEY_CAT.HOUSING, MONEY_CAT.TRANSPORT,
    ]);
    expect(rows[0].share).toBeCloseTo(4_200_000 / 7_500_000, 5);
  });

  it('compares against the median of complete months only', () => {
    // August is in progress, so including it would drag its own baseline toward
    // itself and no month could ever look unusual.
    const rows = categoryBreakdown(all, '2026-08', categoryNorms(all, today));
    const food = rows.find((r) => r.category === MONEY_CAT.FOOD)!;
    expect(food.normal).toBe(2_800_000);
    expect(food.normalMonths).toBe(2);
  });

  it('leaves a category with no history without a comparison', () => {
    const rows = categoryBreakdown(all, '2026-08', categoryNorms(all, today));
    expect(rows.find((r) => r.category === MONEY_CAT.TRANSPORT)!.normal).toBeNull();
  });
});

describe('forecastMonth', () => {
  const today = '2026-08-14';

  it('does not forecast a second rent', () => {
    // The whole reason the fixed/variable split exists. 3tr rent + 2tr8 food in
    // 14 days is 5tr8; multiplying that by 31/14 says 12tr8 — two rents. The
    // right answer counts rent once and extrapolates only the food.
    const all = [
      entry('2026-08-05', 'trọ', -3_000_000, MONEY_CAT.HOUSING),
      entry('2026-08-10', 'ăn', -2_800_000, MONEY_CAT.FOOD),
    ];
    const f = forecastMonth(all, '2026-08', today)!;
    expect(f.fixedSoFar).toBe(3_000_000);
    expect(f.variableSoFar).toBe(2_800_000);
    expect(f.projected).toBe(3_000_000 + Math.round((2_800_000 / 14) * 31));
    expect(f.projected).toBeLessThan(12_000_000);
  });

  it('still expects rent that has not landed yet', () => {
    // The opposite failure: on the 14th with rent due on the 28th, counting
    // only what has happened understates the month by a whole rent.
    const all = [
      entry('2026-06-28', 'trọ', -3_000_000, MONEY_CAT.HOUSING),
      entry('2026-07-28', 'trọ', -3_000_000, MONEY_CAT.HOUSING),
      entry('2026-08-10', 'ăn', -1_400_000, MONEY_CAT.FOOD),
    ];
    const f = forecastMonth(all, '2026-08', today)!;
    expect(f.fixedSoFar).toBe(0);
    expect(f.expectedFixed).toBe(3_000_000);
    expect(f.projected).toBeGreaterThan(3_000_000);
  });

  it('refuses to project a month that has not started', () => {
    expect(forecastMonth([], '2026-09', today)).toBeNull();
  });
});

describe('estimateNextMonth', () => {
  const today = '2026-08-14';

  it('prefers the median of complete months and says how many', () => {
    const all = [
      entry('2026-05-01', 'trọ', -3_000_000, MONEY_CAT.HOUSING),
      entry('2026-05-05', 'ăn', -2_000_000, MONEY_CAT.FOOD),
      entry('2026-06-01', 'trọ', -3_000_000, MONEY_CAT.HOUSING),
      entry('2026-06-05', 'ăn', -3_000_000, MONEY_CAT.FOOD),
      entry('2026-07-01', 'trọ', -3_000_000, MONEY_CAT.HOUSING),
      entry('2026-07-05', 'ăn', -2_500_000, MONEY_CAT.FOOD),
    ];
    const est = estimateNextMonth(all, '2026-08', today)!;
    expect(est.month).toBe('2026-09');
    expect(est.fixed).toBe(3_000_000);
    expect(est.variable).toBe(2_500_000);
    expect(est.basedOnMonths).toBe(3);
  });

  it('falls back to this month alone, and admits it', () => {
    const all = [entry('2026-08-01', 'ăn', -1_400_000, MONEY_CAT.FOOD)];
    const est = estimateNextMonth(all, '2026-08', today)!;
    expect(est.basedOnMonths).toBe(0);
  });
});

describe('allowance', () => {
  const today = '2026-08-14';

  it('sets aside fixed costs that have not landed yet', () => {
    // Rent due on the 28th is not money you may spend on the 20th. An allowance
    // that ignores it is confidently wrong in the direction that costs you.
    const all = [
      entry('2026-06-28', 'trọ', -3_000_000, MONEY_CAT.HOUSING),
      entry('2026-07-28', 'trọ', -3_000_000, MONEY_CAT.HOUSING),
      entry('2026-08-10', 'ăn', -1_000_000, MONEY_CAT.FOOD),
    ];
    const f = forecastMonth(all, '2026-08', today)!;
    const a = allowance(f, 10_000_000)!;
    expect(a.remaining).toBe(10_000_000 - 1_000_000 - 3_000_000);
    expect(a.daysLeft).toBe(17);
    expect(a.over).toBe(false);
  });

  it('reports going over rather than clamping to zero', () => {
    const all = [entry('2026-08-02', 'mua laptop', -20_000_000, MONEY_CAT.SHOPPING)];
    const f = forecastMonth(all, '2026-08', today)!;
    const a = allowance(f, 10_000_000)!;
    expect(a.over).toBe(true);
    expect(a.remaining).toBeLessThan(0);
  });

  it('has nothing to say without a budget', () => {
    const f = forecastMonth([entry('2026-08-01', 'ăn', -100_000)], '2026-08', today)!;
    expect(allowance(f, 0)).toBeNull();
  });
});

describe('detectRecurring', () => {
  const today = '2026-08-20';

  it('finds a monthly charge at a steady amount', () => {
    const all = [
      entry('2026-05-02', 'netflix 260k', -260_000, MONEY_CAT.ENTERTAINMENT),
      entry('2026-06-02', 'netflix 260k', -260_000, MONEY_CAT.ENTERTAINMENT),
      entry('2026-07-02', 'netflix 260k', -260_000, MONEY_CAT.ENTERTAINMENT),
    ];
    const hits = detectRecurring(all, today);
    expect(hits).toHaveLength(1);
    expect(hits[0].amount).toBe(260_000);
    expect(hits[0].count).toBe(3);
    expect(hits[0].avgGapDays).toBeGreaterThanOrEqual(30);
  });

  it('ignores a habit whose amount jumps around', () => {
    // "cà phê" every month is not a subscription, and a list that flags it is a
    // list nobody reads twice.
    const all = [
      entry('2026-05-02', 'cà phê', -35_000, MONEY_CAT.FOOD),
      entry('2026-06-02', 'cà phê', -85_000, MONEY_CAT.FOOD),
      entry('2026-07-02', 'cà phê', -150_000, MONEY_CAT.FOOD),
    ];
    expect(detectRecurring(all, today)).toEqual([]);
  });

  it('ignores something seen only twice', () => {
    const all = [
      entry('2026-06-02', 'netflix', -260_000),
      entry('2026-07-02', 'netflix', -260_000),
    ];
    expect(detectRecurring(all, today)).toEqual([]);
  });

  it('ignores a daily habit — the gap is nothing like a month', () => {
    const all = [
      entry('2026-08-01', 'gửi xe', -5_000),
      entry('2026-08-02', 'gửi xe', -5_000),
      entry('2026-08-03', 'gửi xe', -5_000),
      entry('2026-08-04', 'gửi xe', -5_000),
    ];
    expect(detectRecurring(all, today)).toEqual([]);
  });
});

describe('anomalies', () => {
  it('flags a day that cost several times a normal one', () => {
    const all = [
      ...Array.from({ length: 10 }, (_, i) =>
        entry(`2026-08-${String(i + 1).padStart(2, '0')}`, 'ăn', -100_000, MONEY_CAT.FOOD)),
      entry('2026-08-12', 'mua tai nghe', -700_000, MONEY_CAT.SHOPPING),
      entry('2026-08-12', 'ăn', -150_000, MONEY_CAT.FOOD),
    ];
    const odd = anomalies(all, '2026-08');
    expect(odd).toHaveLength(1);
    expect(odd[0].date).toBe('2026-08-12');
    expect(odd[0].total).toBe(850_000);
    // The biggest line is the explanation, so it is the one shown.
    expect(odd[0].biggest).toBe('mua tai nghe');
    expect(odd[0].ratio).toBeGreaterThan(2.5);
  });

  it('says nothing when every day looks the same', () => {
    const all = Array.from({ length: 10 }, (_, i) =>
      entry(`2026-08-${String(i + 1).padStart(2, '0')}`, 'ăn', -100_000, MONEY_CAT.FOOD));
    expect(anomalies(all, '2026-08')).toEqual([]);
  });
});

describe('searchEntries', () => {
  const all = [
    entry('2026-08-01', 'Cà phê với anh Tuấn', -85_000, MONEY_CAT.FOOD),
    entry('2026-08-02', 'ca phe sang', -30_000, MONEY_CAT.FOOD),
    entry('2026-08-03', 'grab về nhà', -42_000, MONEY_CAT.TRANSPORT),
    entry('2026-08-04', 'Chỉnh số dư', -100_000, MONEY_CAT.ADJUSTMENT),
  ];

  it('finds accented text from an unaccented query, and the reverse', () => {
    // The point of the feature: "Food & Drink" is somebody else's bucket, but
    // "cà phê" is the thing you wanted to know about.
    expect(searchEntries(all, 'ca phe').matches).toHaveLength(2);
    expect(searchEntries(all, 'cà phê').matches).toHaveLength(2);
    expect(searchEntries(all, 'CA PHE').matches).toHaveLength(2);
  });

  it('totals the matches', () => {
    expect(searchEntries(all, 'ca phe').spent).toBe(115_000);
  });

  it('leaves corrections out of the total even when they match', () => {
    const r = searchEntries(all, 'số dư');
    expect(r.matches).toHaveLength(1);
    expect(r.spent).toBe(0);
  });

  it('returns nothing for an empty query rather than everything', () => {
    expect(searchEntries(all, '   ').matches).toEqual([]);
  });
});

describe('ledgerFrom', () => {
  const all = [
    entry('2026-05-01', 'mượn mẹ 5tr', 5_000_000, MONEY_CAT.BORROWING,
      { counterparty: 'mẹ', debtDelta: 5_000_000 }),
    entry('2026-07-01', 'trả mẹ 2tr', -2_000_000, MONEY_CAT.DEBT_REPAYMENT,
      { counterparty: 'mẹ', debtDelta: -2_000_000 }),
    entry('2026-06-01', 'cho Tuấn mượn 1tr', -1_000_000, MONEY_CAT.OTHER,
      { counterparty: 'Tuấn', debtDelta: -1_000_000 }),
    entry('2026-06-20', 'Tuấn trả 1tr', 1_000_000, MONEY_CAT.OTHER,
      { counterparty: 'Tuấn', debtDelta: 1_000_000 }),
  ];

  it('nets each person out and drops the settled ones', () => {
    const rows = ledgerFrom(all, '2026-08-14');
    expect(rows).toHaveLength(1);
    expect(rows[0].counterparty).toBe('mẹ');
    expect(rows[0].balance).toBe(3_000_000);
    expect(rows[0].borrowed).toBe(5_000_000);
    expect(rows[0].repaid).toBe(2_000_000);
  });

  it('ages the debt from its first movement, not its last', () => {
    // "mẹ is owed 3 triệu" and "mẹ has been owed 3 triệu since May" are
    // different sentences, and only the second one makes anybody do something.
    expect(ledgerFrom(all, '2026-08-14')[0].ageDays).toBe(105);
  });
});

describe('rhythm', () => {
  it('lines spending up against the mood logged the same day', () => {
    const all = [
      entry('2026-08-01', 'ăn', -100_000, MONEY_CAT.FOOD),
      entry('2026-08-02', 'mua sắm', -900_000, MONEY_CAT.SHOPPING),
      entry('2026-08-03', 'ăn', -120_000, MONEY_CAT.FOOD),
    ];
    const rows = spendByMood(all, {
      '2026-08-01': { energy: 4 },
      '2026-08-02': { energy: 2 },
      '2026-08-03': { energy: 4 },
      // A day with a mood but no spending contributes nothing rather than a zero.
      '2026-08-09': { energy: 5 },
    });
    expect(rows).toEqual([
      { energy: 2, days: 1, medianSpend: 900_000 },
      { energy: 4, days: 2, medianSpend: 110_000 },
    ]);
  });

  it('indexes weekdays from Monday, so the weekend is 5 and 6', () => {
    // 2026-08-15 is a Saturday.
    const rows = spendByWeekday([entry('2026-08-15', 'đi chơi', -400_000)]);
    expect(rows).toEqual([{ day: 5, days: 1, medianSpend: 400_000 }]);
  });
});
