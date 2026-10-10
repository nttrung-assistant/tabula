import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, parse, normalizeRef, refLabel, parseCell, evaluate } from "../src/formula.js";

function sheet(cells) {
  // cells: { "A1": "raw", ... } -> dense grid big enough for all refs
  let maxR = 0, maxC = 0;
  for (const k of Object.keys(cells)) {
    const ref = normalizeRef(k);
    if (ref.r > maxR) maxR = ref.r;
    if (ref.c > maxC) maxC = ref.c;
  }
  const grid = [];
  for (let r = 0; r <= maxR; r++) {
    const row = [];
    for (let c = 0; c <= maxC; c++) row.push(parseCell(cells[refLabel({ r, c })] ?? ""));
    grid.push(row);
  }
  return grid;
}

function val(cells, k) {
  const res = evaluate(sheet(cells));
  const ref = normalizeRef(k);
  return res.values[ref.r][ref.c];
}

test("tokenizer splits formulas into expected token kinds", () => {
  const kinds = tokenize('SUM(A1:B2)+3.5*"x"').map((t) => t.type);
  assert.deepEqual(kinds, ["func", "ref", "sep", "ref", ")", "op", "num", "op", "str"]);
});

test("tokenizer rejects garbage with position info", () => {
  assert.throws(() => tokenize("1 + @"), /Unexpected/);
});

test("parser builds a comparison tree with correct precedence", () => {
  // 1 + 2 * 3 must group as 1 + (2*3)
  const ast = parse(tokenize("1+2*3"));
  assert.equal(ast.kind, "bin");
  assert.equal(ast.op, "+");
  assert.equal(ast.args[1].op, "*");
  // power is right-assoc: 2^3^2 = 2^(3^2) = 512
  const v = val({ A1: "=2^3^2" }, "A1");
  assert.equal(v.v, 512);
});

test("arithmetic, unary minus, postfix percent", () => {
  assert.equal(val({ A1: "=1+2*3" }, "A1").v, 7);
  assert.equal(val({ A1: "=-4+10" }, "A1").v, 6);
  assert.equal(val({ A1: "=50%*200" }, "A1").v, 100);
  assert.equal(val({ A1: "=10/4" }, "A1").v, 2.5);
});

test("cell references and ranges", () => {
  const cells = { A1: "10", A2: "20", A3: "30", B1: "=A1+A2", B2: "=SUM(A1:A3)", B3: "=AVERAGE(A1:A3)" };
  assert.equal(val(cells, "B1").v, 30);
  assert.equal(val(cells, "B2").v, 60);
  assert.equal(val(cells, "B3").v, 20);
});

test("recalculation flows through dependencies", () => {
  const cells = { A1: "2", B1: "=A1*10", C1: "=B1+5" };
  assert.equal(val(cells, "C1").v, 25);
  cells.A1 = "3";
  assert.equal(val(cells, "C1").v, 35);
});

test("IF and logic functions", () => {
  assert.equal(val({ A1: '=IF(1<2,"yes","no")' }, "A1").v, "yes");
  assert.equal(val({ A1: "=IF(FALSE,1,2)" }, "A1").v, 2);
  assert.equal(val({ A1: "=AND(1,TRUE)" }, "A1").v, true);
  assert.equal(val({ A1: "=OR(FALSE,0)" }, "A1").v, false);
  assert.equal(val({ A1: "=NOT(0)" }, "A1").v, true);
});

test("string functions and concatenation", () => {
  assert.equal(val({ A1: '="tab"&"ula"' }, "A1").v, "tabula");
  assert.equal(val({ A1: '=UPPER("abc")' }, "A1").v, "ABC");
  assert.equal(val({ A1: '=LEN("hello")' }, "A1").v, 5);
  assert.equal(val({ A1: '=LEFT("spreadsheet",6)' }, "A1").v, "spread");
  assert.equal(val({ A1: '=FIND("e","hello")' }, "A1").v, 2);
  assert.equal(val({ A1: '=CONCAT("a",1,TRUE)' }, "A1").v, "a1TRUE");
});

test("math functions", () => {
  assert.equal(val({ A1: "=ROUND(3.14159,2)" }, "A1").v, 3.14);
  assert.equal(val({ A1: "=SQRT(144)" }, "A1").v, 12);
  assert.equal(val({ A1: "=POWER(2,10)" }, "A1").v, 1024);
  assert.equal(val({ A1: "=MOD(10,3)" }, "A1").v, 1);
  assert.equal(val({ A1: "=MAX(4,9,2)" }, "A1").v, 9);
  assert.equal(val({ A1: "=MIN(4,9,2)" }, "A1").v, 2);
  assert.equal(val({ A1: "=COUNT(1,\"x\",2,3)" }, "A1").v, 3);
});

test("division by zero yields #DIV/0! error", () => {
  const v = val({ A1: "=1/0" }, "A1");
  assert.equal(v.err, true);
  assert.match(v.v, /#DIV\/0!/);
});

test("unknown function yields #NAME? error", () => {
  const v = val({ A1: "=NOSUCHFN(1)" }, "A1").v;
  assert.match(String(v), /#NAME\?/);
});

test("SQRT of negative yields #NUM! error", () => {
  assert.equal(val({ A1: "=SQRT(-1)" }, "A1").err, true);
});

test("reference cycles are detected, not crashed on", () => {
  const cells = { A1: "=B1+1", B1: "=A1+1" };
  const res = evaluate(sheet(cells));
  assert.equal(res.values[0][0].v, "#CYCLE");
  assert.equal(res.values[0][1].v, "#CYCLE");
});

test("self-reference is a cycle", () => {
  assert.equal(val({ A1: "=A1" }, "A1").v, "#CYCLE");
});

test("parse errors are surfaced per-cell", () => {
  const p = parseCell("=1+");
  assert.ok(p.parseError);
  const grid = sheet({ A1: "=1+" });
  const res = evaluate(grid);
  assert.equal(res.values[0][0].err, true);
});

test("literals parse as numbers and booleans", () => {
  assert.equal(val({ A1: "42" }, "A1").v, 42);
  assert.equal(val({ A1: "3.5" }, "A1").v, 3.5);
  assert.equal(val({ A1: "true" }, "A1").v, true);
  assert.equal(val({ A1: "hello" }, "A1").v, "hello");
});

test("normalizeRef and refLabel round-trip", () => {
  assert.deepEqual(normalizeRef("A1"), { c: 0, r: 0 });
  assert.deepEqual(normalizeRef("$B$2"), { c: 1, r: 1 });
  assert.deepEqual(normalizeRef("AA10"), { c: 26, r: 9 });
  assert.equal(refLabel({ c: 0, r: 0 }), "A1");
  assert.equal(refLabel({ c: 26, r: 9 }), "AA10");
});

test("comparison operators on numbers and strings", () => {
  assert.equal(val({ A1: "=2>=2" }, "A1").v, true);
  assert.equal(val({ A1: '="a"<"b"' }, "A1").v, true);
  assert.equal(val({ A1: "=1<>2" }, "A1").v, true);
  assert.equal(val({ A1: '="x"="x"' }, "A1").v, true);
});

test("chain of mixed text and numbers computes without wrong-type crashes", () => {
  const cells = {
    A1: "Item", B1: "Qty", C1: "Price", D1: "Total",
    A2: "Widget", B2: "3", C2: "9.99", D2: "=B2*C2",
    A3: "Gadget", B3: "2", C3: "15", D3: "=B3*C3",
    B5: "=SUM(D2:D3)", B6: '=IF(B5>50,"over","ok")',
  };
  assert.equal(val(cells, "B5").v, 59.97);
  assert.equal(val(cells, "B6").v, "over");
});
