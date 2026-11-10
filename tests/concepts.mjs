// Integrity of the concept list (src/shared/prompts.ts) against the model's classes.
// No server needed:   node --experimental-strip-types tests/concepts.mjs
import { readFileSync } from "node:fs";
import { PROMPTS, acceptedLabels } from "../src/shared/prompts.ts";

let pass = 0, fail = 0;
const assert = (c, l) => { c ? (pass++, console.log("  PASS:", l)) : (fail++, console.log("  FAIL:", l)); };

const classes = new Set(readFileSync(new URL("../public/model/class_names.txt", import.meta.url), "utf8").split("\n").map((s) => s.trim()).filter(Boolean));
const labels = PROMPTS.map((p) => p.label);
const aliases = PROMPTS.flatMap((p) => p.also ?? []);

console.log(`[${PROMPTS.length} conceitos]`);
assert(PROMPTS.length >= 40, `há conceitos suficientes para partidas de 10 desenhos (${PROMPTS.length})`);
assert(labels.every((l) => classes.has(l)), "todo conceito é uma classe que o modelo conhece" + (labels.filter((l) => !classes.has(l)).length ? ` — faltam: ${labels.filter((l) => !classes.has(l))}` : ""));
assert(new Set(labels).size === labels.length, "nenhum conceito repetido" + (new Set(labels).size !== labels.length ? ` — repetidos: ${labels.filter((l, i) => labels.indexOf(l) !== i)}` : ""));
assert(PROMPTS.every((p) => p.pt.trim().length > 0), "todo conceito tem nome em português");
const pts = PROMPTS.map((p) => p.pt.toLowerCase());
assert(new Set(pts).size === pts.length, "nenhum nome em português repetido" + (new Set(pts).size !== pts.length ? ` — repetidos: ${pts.filter((x, i) => pts.indexOf(x) !== i)}` : ""));

console.log("[sinônimos]");
assert(aliases.every((a) => classes.has(a)), "todo sinônimo é uma classe do modelo");
assert(PROMPTS.every((p) => !(p.also ?? []).includes(p.label)), "um conceito não lista a si mesmo como sinônimo");
assert(aliases.every((a) => !labels.includes(a)), "um sinônimo nunca é, ele próprio, outro conceito do jogo (a resposta seria ambígua)");
assert(new Set(aliases).size === aliases.length, "um sinônimo pertence a um só conceito");
assert(JSON.stringify(acceptedLabels("cup")) === JSON.stringify(["cup", "mug", "coffee_cup"]), "xícara aceita caneca e xícara de café");
assert(JSON.stringify(acceptedLabels("apple")) === JSON.stringify(["apple"]), "conceito sem sinônimo aceita só a si mesmo");
assert(JSON.stringify(acceptedLabels("not_a_class")) === JSON.stringify(["not_a_class"]), "rótulo desconhecido não quebra");

console.log("[conceitos removidos por baixo acerto]");
for (const l of ["dog", "pencil", "snake"]) assert(!labels.includes(l), `'${l}' fora da lista (acerto de 33% a 46% nos testes)`);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
