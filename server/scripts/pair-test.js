// Sorts photos as one free-style capture session (server/src/pairing.js) and prints what
// it made of them: node --env-file=../.env scripts/pair-test.js <photo>… (in the order taken)
import { readFile } from 'node:fs/promises';
import { sortShots } from '../src/pairing.js';

const files = process.argv.slice(2);
const shots = await Promise.all(files.map(async (f, seq) => ({ seq, buf: await readFile(f), meta: {} })));
const t0 = Date.now();
const r = await sortShots(shots, { log: (x) => console.log(JSON.stringify(x)) });
const name = (i) => files[i].split('/').slice(-2).join('/');
console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const b of r.books) console.log('BOOK  front:', b.front.map(name).join(', ') || '-', ' back:', b.back.map(name).join(', ') || '-', b.codes.join(' '));
for (const s of r.shelves) console.log('SHELF', s.map(name).join(', '));
if (r.other.length) console.log('OTHER', r.other.map(name).join(', '));
