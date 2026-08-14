/**
 * Wallets, and the one decision that shapes all of them: a wallet has no stored
 * balance. It is the sum of the entries that moved through it, every time.
 *
 * That is not fussiness. A stored counter that two devices both increment is
 * wrong forever with no way to tell afterwards, which is the same reason the
 * debt ledger is a SUM and the day total is recomputed. So "correct my balance"
 * — the whole point of wallets in a log you type by hand — has to be expressed
 * as an entry rather than as an assignment, and these tests pin that down.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  addMoneyEntry,
  correctWalletBalance,
  createWallet,
  deleteWallet,
  moveEntryToWallet,
  readMoneyAll,
  readWallets,
  renameWallet,
  updateMoneyEntry,
  walletBalance,
  readMonthlyBudget,
  setMonthlyBudget,
} from '../weeklyPlans';
import { MONEY_CAT } from '../../lib/moneyTaxonomy';

const DATE = '2026-08-12';

/** Give a line an amount the way useMoneySync does after a parse. */
function parse(ydoc: Y.Doc, id: string, amount: number, text: string) {
  updateMoneyEntry(ydoc, id, { amount, status: 'ok', parsedFrom: text, category: MONEY_CAT.FOOD });
}

describe('wallets', () => {
  it('starts a wallet with an opening balance written as an entry, not a field', () => {
    const ydoc = new Y.Doc();
    const id = createWallet(ydoc, 'Tiền mặt', '💵', 2_000_000, 'Số dư đầu');

    expect(walletBalance(readMoneyAll(ydoc), id, true)).toBe(2_000_000);
    // The opening balance is visible in the log as a dated line, which is what
    // makes it auditable later.
    const [opening] = readMoneyAll(ydoc);
    expect(opening.category).toBe(MONEY_CAT.ADJUSTMENT);
    expect(opening.amount).toBe(2_000_000);
    expect(opening.walletId).toBe(id);
  });

  it('writes no entry at all when the opening balance is zero', () => {
    const ydoc = new Y.Doc();
    createWallet(ydoc, 'Momo', '📱', 0);
    expect(readMoneyAll(ydoc)).toEqual([]);
  });

  it('a correction line is born already parsed, so it never reaches the model', () => {
    // parsedFrom === text is exactly what useMoneySync's dirty-check looks at.
    // Getting this wrong would bill the user to be told what "Chỉnh số dư" means.
    const ydoc = new Y.Doc();
    createWallet(ydoc, 'Tiền mặt', '💵', 500_000, 'Số dư đầu');
    const [opening] = readMoneyAll(ydoc);
    expect(opening.parsedFrom).toBe(opening.text);
    expect(opening.status).toBe('ok');
  });

  it('is the sum of its entries, and only its own', () => {
    const ydoc = new Y.Doc();
    const cash = createWallet(ydoc, 'Tiền mặt', '💵', 1_000_000, 'đầu');
    const bank = createWallet(ydoc, 'Ngân hàng', '🏦', 5_000_000, 'đầu');

    const a = addMoneyEntry(ydoc, DATE, 'cà phê 85k', cash);
    parse(ydoc, a, -85_000, 'cà phê 85k');
    const b = addMoneyEntry(ydoc, DATE, 'điện 400k', bank);
    parse(ydoc, b, -400_000, 'điện 400k');

    const all = readMoneyAll(ydoc);
    expect(walletBalance(all, cash, true)).toBe(915_000);
    expect(walletBalance(all, bank, false)).toBe(4_600_000);
  });

  it('folds unassigned lines into the default wallet', () => {
    // Everything logged before wallets existed carries walletId null. Without
    // this, shipping wallets would have made a year of entries vanish from the
    // only view that shows a balance.
    const ydoc = new Y.Doc();
    const old = addMoneyEntry(ydoc, DATE, 'cà phê 85k');
    parse(ydoc, old, -85_000, 'cà phê 85k');

    const cash = createWallet(ydoc, 'Tiền mặt', '💵', 1_000_000, 'đầu');
    const bank = createWallet(ydoc, 'Ngân hàng', '🏦', 0);

    const all = readMoneyAll(ydoc);
    expect(walletBalance(all, cash, true)).toBe(915_000);
    expect(walletBalance(all, bank, false)).toBe(0);
  });

  it('flagged lines contribute nothing rather than a guessed zero', () => {
    const ydoc = new Y.Doc();
    const id = createWallet(ydoc, 'Tiền mặt', '💵', 1_000_000, 'đầu');
    addMoneyEntry(ydoc, DATE, 'ăn trưa với mấy đứa', id);
    expect(walletBalance(readMoneyAll(ydoc), id, true)).toBe(1_000_000);
  });
});

describe('correctWalletBalance', () => {
  it('makes the balance match what you say is really there', () => {
    const ydoc = new Y.Doc();
    const id = createWallet(ydoc, 'Tiền mặt', '💵', 1_000_000, 'đầu');
    const a = addMoneyEntry(ydoc, DATE, 'cà phê 85k', id);
    parse(ydoc, a, -85_000, 'cà phê 85k');

    const before = walletBalance(readMoneyAll(ydoc), id, true);
    expect(before).toBe(915_000);

    correctWalletBalance(ydoc, id, 800_000, before, 'Chỉnh số dư', DATE);
    expect(walletBalance(readMoneyAll(ydoc), id, true)).toBe(800_000);
  });

  it('records the drift as a dated line rather than overwriting anything', () => {
    const ydoc = new Y.Doc();
    const id = createWallet(ydoc, 'Tiền mặt', '💵', 1_000_000, 'đầu');
    correctWalletBalance(ydoc, id, 800_000, 1_000_000, 'Chỉnh số dư', DATE);

    const fix = readMoneyAll(ydoc).find((e) => e.text === 'Chỉnh số dư')!;
    expect(fix.amount).toBe(-200_000);
    expect(fix.date).toBe(DATE);
    // The original opening line is untouched — the history still says when it
    // drifted and by how much, which an assignment would have thrown away.
    expect(readMoneyAll(ydoc).filter((e) => e.category === MONEY_CAT.ADJUSTMENT)).toHaveLength(2);
  });

  it('writes nothing when nothing had drifted', () => {
    const ydoc = new Y.Doc();
    const id = createWallet(ydoc, 'Tiền mặt', '💵', 1_000_000, 'đầu');
    expect(correctWalletBalance(ydoc, id, 1_000_000, 1_000_000, 'Chỉnh số dư')).toBeNull();
    expect(readMoneyAll(ydoc)).toHaveLength(1);
  });
});

describe('editing wallets', () => {
  it('deleting a wallet keeps its lines and hands them to the default', () => {
    // The spending really happened; only the label for where the money sat has
    // gone. Deleting the lines with it would silently drop a month's totals.
    const ydoc = new Y.Doc();
    const cash = createWallet(ydoc, 'Tiền mặt', '💵', 0);
    const momo = createWallet(ydoc, 'Momo', '📱', 0);
    const a = addMoneyEntry(ydoc, DATE, 'cà phê 85k', momo);
    parse(ydoc, a, -85_000, 'cà phê 85k');

    deleteWallet(ydoc, momo);

    expect(readWallets(ydoc).map((w) => w.id)).toEqual([cash]);
    const all = readMoneyAll(ydoc);
    expect(all).toHaveLength(1);
    expect(all[0].walletId).toBeNull();
    expect(walletBalance(all, cash, true)).toBe(-85_000);
  });

  it('moves one line between wallets', () => {
    const ydoc = new Y.Doc();
    const cash = createWallet(ydoc, 'Tiền mặt', '💵', 0);
    const bank = createWallet(ydoc, 'Ngân hàng', '🏦', 0);
    const a = addMoneyEntry(ydoc, DATE, 'điện 400k', cash);
    parse(ydoc, a, -400_000, 'điện 400k');

    moveEntryToWallet(ydoc, a, bank);

    const all = readMoneyAll(ydoc);
    expect(walletBalance(all, cash, true)).toBe(0);
    expect(walletBalance(all, bank, false)).toBe(-400_000);
  });

  it('renames without disturbing the balance', () => {
    const ydoc = new Y.Doc();
    const id = createWallet(ydoc, 'Tiền mặt', '💵', 1_000_000, 'đầu');
    renameWallet(ydoc, id, 'Ví da', '👛');
    const [w] = readWallets(ydoc);
    expect(w.name).toBe('Ví da');
    expect(w.icon).toBe('👛');
    expect(walletBalance(readMoneyAll(ydoc), id, true)).toBe(1_000_000);
  });

  it('ignores an empty rename instead of leaving a nameless wallet', () => {
    const ydoc = new Y.Doc();
    const id = createWallet(ydoc, 'Tiền mặt', '💵', 0);
    renameWallet(ydoc, id, '   ');
    expect(readWallets(ydoc)[0].name).toBe('Tiền mặt');
  });
});

describe('convergence', () => {
  it('two devices each making a wallet offline end up with both', () => {
    // The failure this rules out is the one that made moneyLog top-level in the
    // first place: a nested container created by two peers is a same-key
    // conflict, and one side's whole map is discarded on merge.
    const a = new Y.Doc();
    const b = new Y.Doc();

    const cash = createWallet(a, 'Tiền mặt', '💵', 1_000_000, 'đầu');
    const momo = createWallet(b, 'Momo', '📱', 500_000, 'đầu');

    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));

    for (const doc of [a, b]) {
      const names = readWallets(doc).map((w) => w.name).sort();
      expect(names).toEqual(['Momo', 'Tiền mặt']);
      const all = readMoneyAll(doc);
      expect(walletBalance(all, cash, false)).toBe(1_000_000);
      expect(walletBalance(all, momo, false)).toBe(500_000);
    }
  });

  it('two devices correcting the same wallet keep both corrections', () => {
    // Both people looked in the same pocket and both wrote down what they saw.
    // Neither correction is lost — which is the behaviour a stored balance
    // could not have given, since one assignment would simply overwrite the
    // other and no one would ever know.
    const a = new Y.Doc();
    const id = createWallet(a, 'Tiền mặt', '💵', 1_000_000, 'đầu');
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    correctWalletBalance(a, id, 900_000, 1_000_000, 'Chỉnh số dư', '2026-08-10');
    correctWalletBalance(b, id, 950_000, 1_000_000, 'Chỉnh số dư', '2026-08-11');

    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));

    for (const doc of [a, b]) {
      expect(readMoneyAll(doc).filter((e) => e.category === MONEY_CAT.ADJUSTMENT)).toHaveLength(3);
      expect(walletBalance(readMoneyAll(doc), id, true)).toBe(850_000);
    }
  });
});

describe('monthly budget', () => {
  it('is unset until someone sets it', () => {
    const ydoc = new Y.Doc();
    expect(readMonthlyBudget(ydoc)).toBe(0);
  });

  it('round-trips, and refuses a negative cap', () => {
    const ydoc = new Y.Doc();
    setMonthlyBudget(ydoc, 10_000_000);
    expect(readMonthlyBudget(ydoc)).toBe(10_000_000);
    setMonthlyBudget(ydoc, -5);
    expect(readMonthlyBudget(ydoc)).toBe(0);
  });
});
