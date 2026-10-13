/** Port of MT-Wallet src/lib/budgetMath.ts. Keep the two in step: a budget
 *  answered in chat must match the Budgets page. */

export interface BudgetDef {
  id: string;
  name: string;
  amount: number;
  weeklyAmount: number | null;
  weeklyCount: number | null;
  carryover: boolean;
  isRemainder: boolean;
  /** yyyy-MM-dd. Carry never reaches back before this month. */
  activeFrom: string;
  categoryIds: string[];
  groupIds: string[];
}

export interface BudgetIndex {
  byCategory: Map<string, string>;
  byGroup: Map<string, string>;
  remainderId: string | null;
}

export function buildBudgetIndex(budgets: BudgetDef[]): BudgetIndex {
  const byCategory = new Map<string, string>();
  const byGroup = new Map<string, string>();
  let remainderId: string | null = null;
  for (const b of budgets) {
    if (b.isRemainder) remainderId = b.id;
    for (const c of b.categoryIds) if (!byCategory.has(c)) byCategory.set(c, b.id);
    for (const g of b.groupIds) if (!byGroup.has(g)) byGroup.set(g, b.id);
  }
  return { byCategory, byGroup, remainderId };
}

/** Group first, then category, then the remainder budget: the same precedence
 *  as the app, so a transaction is never charged to two budgets. */
export function attributeTo(
  txn: { category_id?: string | null; group_id?: string | null },
  index: BudgetIndex,
): string | null {
  if (txn.group_id) {
    const viaGroup = index.byGroup.get(txn.group_id);
    if (viaGroup) return viaGroup;
  }
  if (txn.category_id) {
    const viaCategory = index.byCategory.get(txn.category_id);
    if (viaCategory) return viaCategory;
  }
  return index.remainderId ?? null;
}

function addMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export interface MonthStanding {
  base: number;
  carryIn: number;
  allowance: number;
  spent: number;
  remaining: number;
}

/** Carry is symmetric (surplus and overspend both roll forward) and the
 *  deficit is floored at one month's base so one big purchase cannot bury a
 *  budget for half a year. */
export function standingForMonth(
  budget: BudgetDef,
  month: string,
  spentIn: (month: string) => number,
): MonthStanding {
  const start = budget.activeFrom.slice(0, 7);
  const base = budget.amount;
  if (month < start) return { base: 0, carryIn: 0, allowance: 0, spent: 0, remaining: 0 };

  let carryIn = 0;
  if (budget.carryover) {
    for (let m = start; m < month; m = addMonth(m)) {
      carryIn = Math.max(-base, base + carryIn - spentIn(m));
    }
  }
  const allowance = base + carryIn;
  const spent = spentIn(month);
  return { base, carryIn, allowance, spent, remaining: allowance - spent };
}

/** Sum of active base amounts. Carry is excluded on purpose: the ceiling is
 *  the plan, not what happens to be available. */
export function monthlyCeiling(budgets: BudgetDef[], month: string): number {
  return budgets.filter((b) => b.activeFrom.slice(0, 7) <= month).reduce((sum, b) => sum + b.amount, 0);
}

/** Combined rows are one order; everything else counts on its own. */
export function countOrders(txns: { combine: string | null }[]): number {
  const combines = new Set<string>();
  let solo = 0;
  for (const t of txns) {
    if (t.combine) combines.add(t.combine);
    else solo += 1;
  }
  return combines.size + solo;
}
