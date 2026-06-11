import { pool } from '../db';

export interface PlatformStats {
  customers: number;
  elections: number;
  draft: number;
  open: number;
  closed: number;
  ballots: number;
  codesIssued: number;
  paymentsConfirmed: number;
  revenue: Array<{ currency: string; subunits: number }>;
}

/** Privacy-respecting platform analytics — aggregate counts only, no PII. */
export async function getPlatformStats(): Promise<PlatformStats> {
  const [cust, byStatus, ball, codes, pay, rev] = await Promise.all([
    pool.query<{ c: string }>(`SELECT count(*) AS c FROM customers`),
    pool.query<{ status: string; c: string }>(`SELECT status, count(*) AS c FROM elections GROUP BY status`),
    pool.query<{ c: string }>(`SELECT count(*) AS c FROM ballots`),
    pool.query<{ c: string }>(`SELECT count(*) AS c FROM voting_codes`),
    pool.query<{ c: string }>(`SELECT count(*) AS c FROM paystack_payments WHERE status = 'confirmed'`),
    pool.query<{ currency: string; s: string }>(
      `SELECT currency, COALESCE(SUM(amount_subunits), 0) AS s
         FROM paystack_payments WHERE status = 'confirmed' GROUP BY currency`,
    ),
  ]);
  const s = { draft: 0, open: 0, closed: 0 } as Record<string, number>;
  byStatus.rows.forEach((r) => (s[r.status] = Number(r.c)));
  return {
    customers: Number(cust.rows[0].c),
    elections: s.draft + s.open + s.closed,
    draft: s.draft,
    open: s.open,
    closed: s.closed,
    ballots: Number(ball.rows[0].c),
    codesIssued: Number(codes.rows[0].c),
    paymentsConfirmed: Number(pay.rows[0].c),
    revenue: rev.rows.map((r) => ({ currency: r.currency, subunits: Number(r.s) })),
  };
}
