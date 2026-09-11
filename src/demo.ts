/**
 * The 60-second artefact: a backdated correction, and the two different
 * questions it forces you to answer. Run: `npm run demo`
 */
import { createDatabase, bookRate, OPEN } from './temporal.ts';
import { issueQuote, repriceAsOf, seedRates, price, type Risk } from './rating.ts';

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;
const db = createDatabase();
seedRates(db, 'MOTOR', T0);

const risk: Risk = {
  driverAge: 22, vehicleGroup: 35, postcodeArea: 'N', noClaimsYears: 0,
};
const quotedAt = T0 + 100 * DAY;

console.log('\n  RATEVAULT - two time axes, two different questions');
console.log('  ' + '-'.repeat(64));

const original = issueQuote(db, 'REG-1', 'MOTOR', risk, quotedAt);
console.log(`  3 March: quoted GBP ${original.toFixed(2)} to a 22-year-old, group 35,`);
console.log('           area N, no claims history.\n');

const { explain } = price(db, 'MOTOR', risk, quotedAt, quotedAt);
console.log('  How that premium was built:');
console.log(`    base                              400.00`);
for (const e of explain) {
  console.log(`    ${e.factor.padEnd(12)} ${e.bucket.padEnd(14)} x${e.multiplier
    .toFixed(2)}   ${e.runningTotal.toFixed(2)}`);
}

const correctionAt = T0 + 280 * DAY;
bookRate(db, {
  product: 'MOTOR', factor: 'DRIVER_AGE', bucket: 'AGE_17_24', multiplier: 1.55,
  valid_from: T0 + 50 * DAY, valid_to: OPEN, tx_from: correctionAt,
});

console.log('\n  6 months later: the regulator forces the young-driver loading down');
console.log('  from 1.85 to 1.55, BACKDATED to before this quote was issued.\n');

const r = repriceAsOf(db, 'REG-1', correctionAt + DAY);
console.log('  Two questions, two answers:');
console.log(`    "what DID we quote?"            GBP ${r.asQuoted.toFixed(2)}   ` +
            '<- unchanged, and provable');
console.log(`    "what SHOULD we have quoted?"   GBP ${r.asCorrected.toFixed(2)}   ` +
            `<- owed back: GBP ${(r.asQuoted - r.asCorrected).toFixed(2)}`);
console.log('\n  On a single-effective-date schema these are the same number, and');
console.log('  the difference - the entire regulatory question - is invisible.\n');
db.close();
