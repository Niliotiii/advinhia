// Unit test for the cross-verified score aggregation (src/shared/scoring.ts).
// No server needed:   node --experimental-strip-types tests/aggregate.mjs
import { aggregateDrawing, median, DISPUTE_SPREAD } from "../src/shared/scoring.ts";

let pass = 0, fail = 0;
const assert = (c, l) => { c ? (pass++, console.log("  PASS:", l)) : (fail++, console.log("  FAIL:", l)); };
const agg = (...v) => aggregateDrawing(v);

console.log("[median]");
assert(median([0.5]) === 0.5, "um valor");
assert(median([0.9, 0.1, 0.3]) === 0.3, "ímpar: o do meio, independente da ordem");
assert(median([0.2, 0.4]) === 0.3 || Math.abs(median([0.2, 0.4]) - 0.3) < 1e-12, "par: média dos dois do meio");

console.log("[honestos]");
let r = agg(0.3, 0.31, 0.29);
assert(r.percent === 30 && !r.disputed, `3 avaliadores honestos concordam: ${r.percent}% sem divergência`);
r = agg(0.5, 0.52);
assert(r.percent === 51 && !r.disputed, `2 avaliadores próximos: média ${r.percent}%, sem divergência`);
r = agg(0.083);
assert(r.percent === 8 && !r.disputed, "um único avaliador vale por ele");
assert(agg().percent === 0 && !agg().disputed, "sem avaliações -> 0%");

console.log("[trapaça com 3+ avaliadores]");
r = agg(0.3, 0.3, 1.0);
assert(r.percent === 30 && r.disputed, `inflar a própria nota (100%) não passa: ${r.percent}%, marcada como divergente`);
r = agg(0.8, 0.8, 0.0);
assert(r.percent === 80 && r.disputed, `derrubar a nota de outro (0%) não passa: ${r.percent}%`);
r = agg(0.3, 0.3, 0.3, 1.0, 1.0);
assert(r.percent === 30, `2 trapaceiros entre 5 avaliadores também não passam: ${r.percent}%`);

console.log("[2 avaliadores que divergem]");
r = agg(0.9, 0.1);
assert(r.percent === 50 && r.disputed, `sem desempate: média ${r.percent}% e marcada como divergente`);

console.log("[limiar]");
assert(DISPUTE_SPREAD === 0.1, "divergência = mais de 10 pontos");
assert(!agg(0.4, 0.45, 0.48).disputed, "diferença pequena de hardware (<10 pontos) não é divergência");

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
