/**
 * Per-voter, tiered pricing (the Verita billable model).
 *
 * Billable unit: the organiser-declared **registered (enrolled) voter** count
 * for an election. The total count selects ONE bracket and every voter is
 * billed at that flat rate (rewards scale, keeps quoting simple) — see the
 * money spec §6.
 *
 * Rates here are in MAJOR units per voter (naira / dollars). The free bracket
 * (1–10) prices to zero so small elections launch without payment.
 */

export type Currency = 'NGN' | 'USD';

/** A bracket is [inclusiveMaxVoters, ratePerVoterMajorUnits]. */
type Bracket = [number, number];

// Built-in default rate card (money spec §6). The final bracket uses Infinity
// as its ceiling and an "enterprise" rate inside the spec's custom ₦20–25 /
// $0.04–0.05 band so very large elections still price automatically; the UI
// flags it as volume/contact pricing.
const DEFAULT_TABLE: Record<Currency, Bracket[]> = {
  NGN: [
    [10, 0],
    [500, 120],
    [2500, 90],
    [10000, 55],
    [50000, 35],
    [Infinity, 22],
  ],
  USD: [
    [10, 0],
    [500, 0.25],
    [2500, 0.18],
    [10000, 0.12],
    [50000, 0.08],
    [Infinity, 0.045],
  ],
};

// Read the override straight from the environment so this module stays free of
// the config/logger graph (both call process.exit on a bad env) and remains
// unit-testable in isolation.
function rateCard(): Record<Currency, Bracket[]> {
  const raw = process.env.PRICING_TABLE;
  if (!raw) return DEFAULT_TABLE;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<Currency, Bracket[]>>;
    return {
      NGN: normalise(parsed.NGN) ?? DEFAULT_TABLE.NGN,
      USD: normalise(parsed.USD) ?? DEFAULT_TABLE.USD,
    };
  } catch {
    // eslint-disable-next-line no-console
    console.error('Invalid PRICING_TABLE JSON — using built-in rate card');
    return DEFAULT_TABLE;
  }
}

/** Sort brackets ascending and turn a JSON `null`/missing top ceiling into Infinity. */
function normalise(brackets: Bracket[] | undefined): Bracket[] | null {
  if (!Array.isArray(brackets) || brackets.length === 0) return null;
  return brackets
    .map(([max, rate]) => [max == null ? Infinity : Number(max), Number(rate)] as Bracket)
    .sort((a, b) => a[0] - b[0]);
}

export interface Quote {
  voters: number;
  currency: Currency;
  perVoterMajor: number; // rate per voter in major units
  subunits: number; // total charge in subunits (kobo / cents)
  free: boolean; // true when the bracket prices to zero
  custom: boolean; // true for the top (enterprise / volume) bracket
  bracketMax: number; // inclusive voter ceiling of the selected bracket
  bracketLabel: string; // e.g. "501–2,500 voters"
}

const nf = new Intl.NumberFormat('en-US');

function bracketLabel(prevMax: number, max: number): string {
  const lo = prevMax + 1;
  if (max === Infinity) return `${nf.format(lo)}+ voters`;
  return `${nf.format(lo)}–${nf.format(max)} voters`;
}

/**
 * Quote an election from its enrolled-voter count. Voters <= 0 is treated as a
 * zero, free quote (nothing to charge yet).
 */
export function quoteForVoters(votersInput: number, currency?: string): Quote {
  const cur: Currency = currency === 'USD' ? 'USD' : 'NGN';
  const voters = Math.max(0, Math.floor(Number(votersInput) || 0));
  const table = rateCard()[cur];

  let prevMax = 0;
  for (const [max, rate] of table) {
    if (voters <= max) {
      const perVoterMajor = rate;
      const subunits = Math.round(voters * perVoterMajor * 100);
      return {
        voters,
        currency: cur,
        perVoterMajor,
        subunits,
        free: subunits === 0,
        custom: max === Infinity,
        bracketMax: max,
        bracketLabel: bracketLabel(prevMax, max),
      };
    }
    prevMax = max;
  }
  // Unreachable (last bracket is Infinity), but keep TypeScript + runtime safe.
  const [, rate] = table[table.length - 1];
  return {
    voters,
    currency: cur,
    perVoterMajor: rate,
    subunits: Math.round(voters * rate * 100),
    free: false,
    custom: true,
    bracketMax: Infinity,
    bracketLabel: bracketLabel(prevMax, Infinity),
  };
}

/** The full rate card, for display on pricing pages. */
export function rateCardRows(currency?: string): Array<{ label: string; rate: number; free: boolean }> {
  const cur: Currency = currency === 'USD' ? 'USD' : 'NGN';
  const table = rateCard()[cur];
  const rows: Array<{ label: string; rate: number; free: boolean }> = [];
  let prevMax = 0;
  for (const [max, rate] of table) {
    rows.push({ label: bracketLabel(prevMax, max), rate, free: rate === 0 });
    prevMax = max;
  }
  return rows;
}
