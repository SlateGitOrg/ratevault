import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, bookRate, rateAsOf, OPEN } from '../src/temporal.ts';
import { price, issueQuote, repriceAsOf, seedRates, type Risk } from '../src/rating.ts';

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;       // rates first believed
const AREAS = ['N', 'S', 'E', 'W'];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function riskFor(rnd: () => number): Risk {
  return {
    driverAge: 18 + Math.floor(rnd() * 60),
    vehicleGroup: 1 + Math.floor(rnd() * 50),
    postcodeArea: AREAS[Math.floor(rnd() * AREAS.length)]!,
    noClaimsYears: Math.floor(rnd() * 10),
  };
}

/** Issue `n` quotes spread over 24 months. */
function issueMany(db: ReturnType<typeof createDatabase>, n: number) {
  const rnd = mulberry32(7);
  const issued: Array<{ token: string; premium: number }> = [];
  for (let i = 0; i < n; i++) {
    const token = `Q-${i}`;
    const quotedAt = T0 + Math.floor(rnd() * 730) * DAY;
    const premium = issueQuote(db, token, 'MOTOR', riskFor(rnd), quotedAt);
    issued.push({ token, premium });
  }
  return issued;
}

describe('deterministic replay', () => {
  test('THE HEADLINE: replaying every quote reproduces it to the penny', () => {
    const db = createDatabase();
    seedRates(db, 'MOTOR', T0);
    const issued = issueMany(db, 20_000);

    let mismatches = 0;
    for (const q of issued) {
      const { asQuoted } = repriceAsOf(db, q.token, Date.now());
      if (asQuoted !== q.premium) mismatches++;
    }
    assert.equal(mismatches, 0,
      `${mismatches} of ${issued.length} quotes did not reproduce`);
    db.close();
  });

  test('pricing is a pure function - same inputs, same output, always', () => {
    const db = createDatabase();
    seedRates(db, 'MOTOR', T0);
    const risk: Risk = {
      driverAge: 22, vehicleGroup: 35, postcodeArea: 'N', noClaimsYears: 0,
    };
    const first = price(db, 'MOTOR', risk, T0 + DAY, T0 + DAY).premium;
    for (let i = 0; i < 1_000; i++) {
      assert.equal(price(db, 'MOTOR', risk, T0 + DAY, T0 + DAY).premium, first);
    }
    db.close();
  });

  test('a missing rate fails loudly rather than defaulting to 1.0', () => {
    const db = createDatabase();
    seedRates(db, 'MOTOR', T0);
    assert.throws(
      () => price(db, 'MOTOR',
        { driverAge: 30, vehicleGroup: 5, postcodeArea: 'Z', noClaimsYears: 2 },
        T0 + DAY, T0 + DAY),
      /no rate for MOTOR\/TERRITORY\/AREA_Z/,
    );
    db.close();
  });

  test('issuance is idempotent on the token', () => {
    const db = createDatabase();
    seedRates(db, 'MOTOR', T0);
    const risk: Risk = {
      driverAge: 45, vehicleGroup: 12, postcodeArea: 'S', noClaimsYears: 6,
    };
    const a = issueQuote(db, 'TOK-1', 'MOTOR', risk, T0 + DAY);
    const b = issueQuote(db, 'TOK-1', 'MOTOR', risk, T0 + 400 * DAY);
    assert.equal(a, b, 'a retried token must not reprice');
    db.close();
  });
});

describe('the two time axes are genuinely independent', () => {
  test('THE CASE A UNI-TEMPORAL SCHEMA CANNOT REPRESENT', () => {
    const db = createDatabase();
    seedRates(db, 'MOTOR', T0);

    const risk: Risk = {
      driverAge: 22, vehicleGroup: 35, postcodeArea: 'N', noClaimsYears: 0,
    };
    const quotedAt = T0 + 100 * DAY;
    const original = issueQuote(db, 'REG-1', 'MOTOR', risk, quotedAt);

    // Six months later the regulator forces a correction to the young-driver
    // loading, BACKDATED to before this quote was issued.
    const correctionBookedAt = T0 + 280 * DAY;
    bookRate(db, {
      product: 'MOTOR', factor: 'DRIVER_AGE', bucket: 'AGE_17_24',
      multiplier: 1.55,
      valid_from: T0 + 50 * DAY, valid_to: OPEN,
      tx_from: correctionBookedAt,
    });

    const r = repriceAsOf(db, 'REG-1', correctionBookedAt + DAY);

    assert.equal(r.asQuoted, original,
      'what we DID quote must be unchanged by a later correction');
    assert.ok(r.drifted, 'the correction should change what we SHOULD have quoted');
    assert.ok(r.asCorrected < r.asQuoted,
      'the loading was reduced, so the corrected premium must be lower');
    db.close();
  });

  test('the old belief remains queryable after being superseded', () => {
    const db = createDatabase();
    seedRates(db, 'MOTOR', T0);
    const before = rateAsOf(db, 'MOTOR', 'DRIVER_AGE', 'AGE_17_24',
      T0 + 100 * DAY, T0 + 100 * DAY);
    bookRate(db, {
      product: 'MOTOR', factor: 'DRIVER_AGE', bucket: 'AGE_17_24',
      multiplier: 1.55, valid_from: T0 + 50 * DAY, valid_to: OPEN,
      tx_from: T0 + 280 * DAY,
    });
    const stillBefore = rateAsOf(db, 'MOTOR', 'DRIVER_AGE', 'AGE_17_24',
      T0 + 100 * DAY, T0 + 100 * DAY);
    const nowKnown = rateAsOf(db, 'MOTOR', 'DRIVER_AGE', 'AGE_17_24',
      T0 + 100 * DAY, T0 + 300 * DAY);

    assert.equal(stillBefore, before, 'history was rewritten');
    assert.equal(nowKnown, 1.55);
    db.close();
  });

  test('a quote issued after the correction uses the corrected rate', () => {
    const db = createDatabase();
    seedRates(db, 'MOTOR', T0);
    const risk: Risk = {
      driverAge: 22, vehicleGroup: 35, postcodeArea: 'N', noClaimsYears: 0,
    };
    const pre = issueQuote(db, 'PRE', 'MOTOR', risk, T0 + 100 * DAY);
    bookRate(db, {
      product: 'MOTOR', factor: 'DRIVER_AGE', bucket: 'AGE_17_24',
      multiplier: 1.55, valid_from: T0 + 50 * DAY, valid_to: OPEN,
      tx_from: T0 + 280 * DAY,
    });
    const post = issueQuote(db, 'POST', 'MOTOR', risk, T0 + 300 * DAY);
    assert.ok(post < pre);
    db.close();
  });
});

describe('overlapping validity is unrepresentable', () => {
  test('the database rejects an overlapping valid-time range', () => {
    const db = createDatabase();
    db.prepare(
      `INSERT INTO rate (product,factor,bucket,multiplier,valid_from,valid_to,
                         tx_from,tx_to) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('MOTOR', 'NCD', 'NCD_0', 1.3, 0, T0 + 100 * DAY, T0, OPEN);

    assert.throws(
      () => db.prepare(
        `INSERT INTO rate (product,factor,bucket,multiplier,valid_from,valid_to,
                           tx_from,tx_to) VALUES (?,?,?,?,?,?,?,?)`,
      ).run('MOTOR', 'NCD', 'NCD_0', 1.4, T0 + 50 * DAY, T0 + 200 * DAY, T0, OPEN),
      /overlapping valid-time range/,
      'two live rates for one key means the price depends on row order',
    );
    db.close();
  });

  test('adjacent, non-overlapping ranges are fine', () => {
    const db = createDatabase();
    const ins = db.prepare(
      `INSERT INTO rate (product,factor,bucket,multiplier,valid_from,valid_to,
                         tx_from,tx_to) VALUES (?,?,?,?,?,?,?,?)`);
    ins.run('MOTOR', 'NCD', 'NCD_0', 1.3, 0, T0 + 100 * DAY, T0, OPEN);
    ins.run('MOTOR', 'NCD', 'NCD_0', 1.4, T0 + 100 * DAY, OPEN, T0, OPEN);
    const n = db.prepare('SELECT COUNT(*) c FROM rate').get() as { c: number };
    assert.equal(n.c, 2);
    db.close();
  });

  test('a rate range must be non-empty', () => {
    const db = createDatabase();
    assert.throws(() => db.prepare(
      `INSERT INTO rate (product,factor,bucket,multiplier,valid_from,valid_to,
                         tx_from,tx_to) VALUES (?,?,?,?,?,?,?,?)`,
    ).run('MOTOR', 'NCD', 'NCD_0', 1.3, 500, 500, T0, OPEN), /CHECK/);
    db.close();
  });
});
