// Every sound vs the comparison page's numbers (soundcheck.js); exits 1 on a mismatch.
import { soundcheck, format } from '../soundcheck.js';

const rows = soundcheck();
for (const r of rows) console.log(format(r));
process.exit(rows.every((r) => r.ok) ? 0 : 1);
