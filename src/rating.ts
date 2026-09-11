import { DatabaseSync } from 'node:sqlite';
import { rateAsOf, bookRate, OPEN } from './temporal.ts';

/**
 * The rating pipeline.
 *
 * It is a PURE FUNCTION of (risk, rate version). It reads no clock, no global,
 * no environment. That is not tidiness - a single `Date.now()` inside a pricing
 * calculation makes the premium unreproducible, and unreproducible is the same
 * as indefensible when someone asks about a quote from two years ago.
 */

export interface Risk {
  readonly driverAge: number;
  readonly vehicleGroup: number;
  readonly postcodeArea: string;
  readonly noClaimsYears: number;
}

export const BASE_PREMIUM = 400;

function ageBucket(age: number): string {
  if (age < 25) return 'AGE_17_24';
  if (age < 40) return 'AGE_25_39';
  if (age < 65) return 'AGE_40_64';
  return 'AGE_65_PLUS';
}
function vehicleBucket(group: number): string {
  if (group <= 10) return 'VEH_1_10';
  if (group <= 30) return 'VEH_11_30';
  return 'VEH_31_50';
}
function ncdBucket(years: number): string {
  if (years === 0) return 'NCD_0';
  if (years < 5) return 'NCD_1_4';
  return 'NCD_5_PLUS';
}

export interface Explanation {
  readonly factor: string;
  readonly bucket: string;
  readonly multiplier: number;
  readonly runningTotal: number;
}

export interface Priced {
  readonly premium: number;
  readonly explain: readonly Explanation[];
}

/** Round once, at the end, to the penny. Deterministic by construction. */
function toPence(x: number): number {
  return Math.round(x * 100) / 100;
}

export function price(
  db: DatabaseSync, product: string, risk: Risk,
  validAt: number, knownAt: number,
): Priced {
  const lookups: Array<[string, string]> = [
    ['DRIVER_AGE', ageBucket(risk.driverAge)],
    ['VEHICLE', vehicleBucket(risk.vehicleGroup)],
    ['TERRITORY', `AREA_${risk.postcodeArea}`],
    ['NCD', ncdBucket(risk.noClaimsYears)],
  ];

  let total = BASE_PREMIUM;
  const explain: Explanation[] = [];
  for (const [factor, bucket] of lookups) {
    const m = rateAsOf(db, product, factor, bucket, validAt, knownAt);
    if (m === null) {
      // A missing rate is a hard failure. Defaulting to 1.0 would silently
      // mis-price rather than telling you the rate table has a hole.
      throw new Error(`no rate for ${product}/${factor}/${bucket} ` +
                      `valid@${validAt} known@${knownAt}`);
    }
    total *= m;
    explain.push({ factor, bucket, multiplier: m, runningTotal: toPence(total) });
  }
  return { premium: toPence(total), explain };
}

/** Idempotent issuance: the same token always returns the same premium. */
export function issueQuote(
  db: DatabaseSync, token: string, product: string, risk: Risk, quotedAt: number,
): number {
  const existing = db.prepare('SELECT premium FROM quote WHERE token = ?')
    .get(token) as { premium: number } | undefined;
  if (existing) return existing.premium;

  const { premium } = price(db, product, risk, quotedAt, quotedAt);
  db.prepare(
    `INSERT INTO quote (token, product, risk_json, quoted_at, premium)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(token, product, JSON.stringify(risk), quotedAt, premium);
  return premium;
}

/**
 * The two questions, side by side.
 *   asQuoted  - replay with transaction time pinned to the original issue.
 *   asCorrect - replay with transaction time = now, so later backdated
 *               corrections are taken into account.
 * On a uni-temporal schema these are the same number, and the difference -
 * which is the entire regulatory question - is invisible.
 */
export function repriceAsOf(
  db: DatabaseSync, token: string, knownAtNow: number,
): { asQuoted: number; asCorrected: number; drifted: boolean } {
  const q = db.prepare(
    'SELECT product, risk_json, quoted_at, premium FROM quote WHERE token = ?',
  ).get(token) as
    { product: string; risk_json: string; quoted_at: number; premium: number };
  const risk = JSON.parse(q.risk_json) as Risk;

  const asQuoted = price(db, q.product, risk, q.quoted_at, q.quoted_at).premium;
  const asCorrected = price(db, q.product, risk, q.quoted_at, knownAtNow).premium;
  return { asQuoted, asCorrected, drifted: asQuoted !== asCorrected };
}

/** Seed a full rate table believed from `txFrom`, valid for all time. */
export function seedRates(db: DatabaseSync, product: string, txFrom: number): void {
  const table: Array<[string, string, number]> = [
    ['DRIVER_AGE', 'AGE_17_24', 1.85], ['DRIVER_AGE', 'AGE_25_39', 1.10],
    ['DRIVER_AGE', 'AGE_40_64', 0.92], ['DRIVER_AGE', 'AGE_65_PLUS', 1.05],
    ['VEHICLE', 'VEH_1_10', 0.88], ['VEHICLE', 'VEH_11_30', 1.15],
    ['VEHICLE', 'VEH_31_50', 1.70],
    ['TERRITORY', 'AREA_N', 1.22], ['TERRITORY', 'AREA_S', 0.95],
    ['TERRITORY', 'AREA_E', 1.05], ['TERRITORY', 'AREA_W', 0.99],
    ['NCD', 'NCD_0', 1.30], ['NCD', 'NCD_1_4', 1.00], ['NCD', 'NCD_5_PLUS', 0.75],
  ];
  for (const [factor, bucket, multiplier] of table) {
    bookRate(db, {
      product, factor, bucket, multiplier,
      valid_from: 0, valid_to: OPEN, tx_from: txFrom,
    });
  }
}
