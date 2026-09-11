import { DatabaseSync } from 'node:sqlite';

/**
 * THE DIFFERENTIATOR LIVES HERE: two independent time axes.
 *
 *   valid time       - when the rate applied to the world
 *   transaction time - when this system believed it
 *
 * A uni-temporal table with a single `effective_date` column cannot answer both
 * of these at once:
 *
 *   "what did we quote this customer on 3 March?"          (as-of tx time)
 *   "what SHOULD we have quoted, given the correction we
 *    booked in June that was backdated to February?"       (as-of valid time)
 *
 * Conflating them means a backdated correction silently rewrites history, so
 * the first question becomes unanswerable - which is exactly the question a
 * regulator asks. Nothing here is ever updated in place: a correction is a new
 * transaction-time version that closes the old one.
 *
 * Reference target is PostgreSQL `tstzrange` + GiST exclusion constraints; this
 * implementation reproduces the same guarantee with triggers so it runs with
 * no install.
 */

export const OPEN = 253_402_300_799_000; // "until further notice"

export interface RateRow {
  product: string;
  factor: string;
  bucket: string;
  multiplier: number;
  valid_from: number;
  valid_to: number;
  tx_from: number;
  tx_to: number;
}

export function createDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
CREATE TABLE rate (
  id          INTEGER PRIMARY KEY,
  product     TEXT NOT NULL,
  factor      TEXT NOT NULL,
  bucket      TEXT NOT NULL,
  multiplier  REAL NOT NULL,
  valid_from  INTEGER NOT NULL,
  valid_to    INTEGER NOT NULL,
  tx_from     INTEGER NOT NULL,
  tx_to       INTEGER NOT NULL,
  CHECK (valid_from < valid_to),
  CHECK (tx_from  < tx_to)
);

-- Stand-in for a GiST exclusion constraint: within one currently-believed
-- (product, factor, bucket), no two rows may claim overlapping valid time.
-- Overlapping validity means the rating function has two answers, and which
-- one you get depends on row order. That is how a "deterministic" pricing
-- engine quietly stops being deterministic.
CREATE TRIGGER rate_no_overlapping_validity
BEFORE INSERT ON rate
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM rate r
   WHERE r.product = NEW.product
     AND r.factor  = NEW.factor
     AND r.bucket  = NEW.bucket
     AND r.tx_to   = ${OPEN}
     AND NEW.tx_to = ${OPEN}
     AND r.valid_from < NEW.valid_to
     AND NEW.valid_from < r.valid_to
)
BEGIN
  SELECT RAISE(ABORT, 'overlapping valid-time range for this rate');
END;

CREATE TABLE quote (
  id           INTEGER PRIMARY KEY,
  token        TEXT NOT NULL UNIQUE,   -- idempotency key
  product      TEXT NOT NULL,
  risk_json    TEXT NOT NULL,
  quoted_at    INTEGER NOT NULL,       -- both axes are pinned at issue time
  premium      REAL NOT NULL
);
`);
  return db;
}

/**
 * Insert a NEW BELIEF. Any currently-believed row covering the same key and
 * overlapping valid time is closed in transaction time first - it is not
 * deleted, so what we used to believe remains answerable forever.
 */
export function bookRate(
  db: DatabaseSync,
  r: Omit<RateRow, 'tx_to'> & { tx_to?: number },
): void {
  const txFrom = r.tx_from;
  db.prepare(
    `UPDATE rate SET tx_to = ?
      WHERE product = ? AND factor = ? AND bucket = ?
        AND tx_to = ${OPEN}
        AND valid_from < ? AND ? < valid_to`,
  ).run(txFrom, r.product, r.factor, r.bucket, r.valid_to, r.valid_from);

  db.prepare(
    `INSERT INTO rate
       (product, factor, bucket, multiplier, valid_from, valid_to, tx_from, tx_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.product, r.factor, r.bucket, r.multiplier,
        r.valid_from, r.valid_to, txFrom, r.tx_to ?? OPEN);
}

/**
 * The bitemporal lookup. BOTH axes are required arguments - there is no
 * default, because defaulting one of them is precisely how the two questions
 * get conflated.
 */
export function rateAsOf(
  db: DatabaseSync,
  product: string,
  factor: string,
  bucket: string,
  validAt: number,
  knownAt: number,
): number | null {
  const row = db.prepare(
    `SELECT multiplier FROM rate
      WHERE product = ? AND factor = ? AND bucket = ?
        AND valid_from <= ? AND ? < valid_to
        AND tx_from    <= ? AND ? < tx_to
      ORDER BY tx_from DESC LIMIT 1`,
  ).get(product, factor, bucket, validAt, validAt, knownAt, knownAt) as
    { multiplier: number } | undefined;
  return row?.multiplier ?? null;
}
