// Tabula formula engine — tokenizer, recursive-descent parser, evaluator.
// Pure functions, no DOM: testable in node and inlined into the Worker page.

// ---------- Tokenizer ----------

const TOKEN_RE = new RegExp(
  [
    "\\s+", // 1 whitespace (skipped)
    "[A-Za-z_][A-Za-z0-9_]*\\s*\\(", // 2 function name
    "\\$?[A-Za-z]{1,3}\\$?[0-9]{1,4}", // 3 cell reference
    "[0-9]+\\.[0-9]+|[0-9]+\\.(?![.0-9])|\\.[0-9]+|[0-9]+", // 4 number
    '"(?:[^"]|"")*"', // 5 string literal ("" escapes ")
    "<>|<=|>=|<|>", // 6 comparison
    "=", // 6a equality
    "[A-Za-z_][A-Za-z0-9_]*", // 6b bare identifier (TRUE/FALSE)
    "[+\\-*/^%&]", // 7 operator
    "[,:;]", // 8 separators
    "\\(|\\)", // 9 parens
  ].join("|"),
  "g",
);

/** Tokenize a formula body (no leading =). Throws Error with a friendly message. */
export function tokenize(src) {
  const tokens = [];
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(src)) !== null) {
    if (m.index > last) {
      throw new Error(`Unexpected "${src.slice(last, m.index).trim()}" at position ${last}`);
    }
    const raw = m[0];
    if (!/^\s+$/.test(raw)) tokens.push({ type: kind(raw, src, m.index), raw, at: m.index });
    last = TOKEN_RE.lastIndex;
  }
  if (last < src.length) {
    throw new Error(`Unexpected "${src.slice(last).trim()}" at position ${last}`);
  }
  return tokens;
}

function kind(raw, src, at) {
  if (/^\s+$/.test(raw)) return "ws";
  if (raw.endsWith("(") && /[A-Za-z_]/.test(raw[0])) return "func";
  if (/^\$?[A-Za-z]{1,3}\$?[0-9]{1,4}$/.test(raw)) return "ref";
  if (/^[0-9.]/.test(raw)) return "num";
  if (raw.startsWith('"')) return "str";
  if (raw === "<>" || raw === "<=" || raw === ">=" || raw === "<" || raw === ">" || raw === "=") return "cmp";
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return "ident";
  if ("+-*/^%&".includes(raw)) return "op";
  if (",:;".includes(raw)) return "sep";
  if (raw === "(" || raw === ")") return raw;
  throw new Error(`Bad token "${raw}" at position ${at}`);
}

// ---------- Parser (recursive descent, precedence climbing) ----------

// cell -> unary -> power -> mul -> add -> concat -> comparison
export function parse(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const eat = (type, raw) => {
    const t = tokens[i];
    if (!t || t.type !== type || (raw !== undefined && t.raw !== raw)) {
      throw new Error(`Expected ${raw ?? type}${t ? `, got "${t.raw}"` : " but formula ended"}`);
    }
    i += 1;
    return t;
  };

  function parseComparison() {
    let left = parseConcat();
    while (peek()?.type === "cmp") {
      const op = eat("cmp").raw;
      left = { kind: "cmp", op, args: [left, parseConcat()] };
    }
    return left;
  }
  function parseConcat() {
    let left = parseAdd();
    while (peek()?.raw === "&") {
      eat("op");
      left = { kind: "concat", args: [left, parseAdd()] };
    }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    while (peek()?.raw === "+" || peek()?.raw === "-") {
      const op = eat("op").raw;
      left = { kind: "bin", op, args: [left, parseMul()] };
    }
    return left;
  }
  function parseMul() {
    let left = parsePower();
    while (peek()?.raw === "*" || peek()?.raw === "/") {
      const op = eat("op").raw;
      left = { kind: "bin", op, args: [left, parsePower()] };
    }
    return left;
  }
  function parsePower() {
    let base = parseUnary();
    while (peek()?.raw === "%") {
      eat("op");
      base = { kind: "pct", args: [base] }; // postfix percent, e.g. 50%
    }
    if (peek()?.raw === "^") {
      eat("op");
      return { kind: "bin", op: "^", args: [base, parsePower()] }; // right-assoc
    }
    return base;
  }
  function parseUnary() {
    if (peek()?.raw === "-" ) {
      eat("op");
      return { kind: "neg", args: [parseUnary()] };
    }
    if (peek()?.raw === "+") {
      eat("op");
      return parseUnary();
    }
    return parseAtom();
  }
  function parseAtom() {
    const t = peek();
    if (!t) throw new Error("Formula ended unexpectedly");
    if (t.type === "num") { eat("num"); return { kind: "lit", value: Number(t.raw) }; }
    if (t.type === "str") {
      eat("str");
      return { kind: "lit", value: t.raw.slice(1, -1).replace(/""/g, '"') };
    }
    if (t.type === "ident") {
      eat("ident");
      const up = t.raw.toUpperCase();
      if (up === "TRUE") return { kind: "lit", value: true };
      if (up === "FALSE") return { kind: "lit", value: false };
      throw new Error(`#NAME? ${up}`);
    }
    if (t.type === "ref") {
      eat("ref");
      const from = normalizeRef(t.raw);
      if (peek()?.raw === ":") {
        eat("sep");
        const t2 = eat("ref");
        const to = normalizeRef(t2.raw);
        return { kind: "range", from, to };
      }
      return { kind: "ref", ref: from };
    }
    if (t.type === "func") {
      const name = eat("func").raw.replace(/\s*\($/, "").toUpperCase();
      const args = [];
      if (peek()?.raw !== ")") {
        args.push(parseComparison());
        while (peek()?.type === "sep" && peek().raw !== ";") {
          eat("sep");
          if (peek()?.raw === ")") break; // trailing comma
          args.push(parseComparison());
        }
      }
      eat(")", ")");
      return { kind: "call", name, args };
    }
    if (t.raw === "(") {
      eat("(", "(");
      const inner = parseComparison();
      eat(")", ")");
      return inner;
    }
    throw new Error(`Unexpected "${t.raw}"`);
  }

  const ast = parseComparison();
  if (i !== tokens.length) throw new Error(`Unexpected "${tokens[i].raw}" at position ${tokens[i].at}`);
  return ast;
}

/** $A$1 / a1 / AA12 -> { c: 0-based col, r: 0-based row } */
export function normalizeRef(raw) {
  const m = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,4})$/.exec(raw);
  if (!m) throw new Error(`Bad cell reference "${raw}"`);
  let c = 0;
  for (const ch of m[1].toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { c: c - 1, r: Number(m[2]) - 1 };
}

export function refLabel(ref) {
  let c = ref.c + 1;
  let s = "";
  while (c > 0) {
    const rem = (c - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    c = Math.floor((c - 1) / 26);
  }
  return s + (ref.r + 1);
}

// ---------- Evaluator ----------

/** Stable topological order over the formula cells; cycle members returned too. */
export function topoOrder(cells) {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map();
  const order = [];
  const key = (r) => `${r.c},${r.r}`;
  function visit(ref, path) {
    const k = key(ref);
    if (color.get(k) === BLACK) return;
    if (color.get(k) === GREY) {
      // cycle: everything from its first appearance in the current path
      const start = path.indexOf(k);
      for (const pk of path.slice(start)) color.set(pk, BLACK);
      return;
    }
    color.set(k, GREY);
    const node = cells[ref.r]?.[ref.c];
    if (node?.ast) {
      for (const dep of collectRefs(node.ast)) {
        const dk = key(dep);
        if (cells[dep.r]?.[dep.c]?.ast) visit(dep, path.concat(dk));
      }
    }
    // If a nested cycle detection marked this node BLACK, it must not be evaluated.
    if (color.get(k) === BLACK) return;
    color.set(k, BLACK);
    order.push(ref);
  }
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < cells[r].length; c++) {
      if (cells[r][c]?.ast) visit({ c, r }, [`${c},${r}`]);
    }
  }
  return order;
}

function collectRefs(node, out = []) {
  if (!node) return out;
  if (node.kind === "ref") out.push(node.ref);
  if (node.kind === "range") {
    const r1 = Math.min(node.from.r, node.to.r), r2 = Math.max(node.from.r, node.to.r);
    const c1 = Math.min(node.from.c, node.to.c), c2 = Math.max(node.from.c, node.to.c);
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) out.push({ c, r });
  }
  for (const a of node.args ?? []) collectRefs(a, out);
  return out;
}

/**
 * Evaluate the sheet.
 * cells: 2D array of { raw, ast? } — ast parsed formulas only.
 * Returns { values: 2D of {v, err} } with each cell a string, number, bool or Error.
 */
export function evaluate(cells) {
  const EMPTY = { v: "" };
  const order = topoOrder(cells);
  const values = cells.map((row) => row.map(() => EMPTY));
  const key = (r) => `${r.c},${r.r}`;
  const ordered = new Set(order.map(key));

  // Literal (non-formula) cells fill first so formula refs read real values.
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < cells[r].length; c++) {
      const node = cells[r][c];
      if (!node) continue;
      if (!node.ast) {
        values[r][c] = node.parseError
          ? { v: `#ERROR ${node.parseError}`.slice(0, 60), err: true }
          : literalValue(node.raw);
      }
    }
  }
  for (const ref of order) {
    const node = cells[ref.r]?.[ref.c];
    if (!node?.ast) continue;
    try {
      values[ref.r][ref.c] = evalNode(node.ast);
    } catch (e) {
      values[ref.r][ref.c] = { v: `#ERROR ${e.message}`.slice(0, 60), err: true };
    }
  }
  // Formula cells that topoOrder never reached are part of a reference cycle.
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < cells[r].length; c++) {
      const node = cells[r][c];
      if (node?.ast && !ordered.has(key({ c, r }))) {
        values[r][c] = { v: "#CYCLE", err: true };
      }
    }
  }

  function evalNode(node) {
    switch (node.kind) {
      case "lit": return { v: node.value };
      case "ref": {
        const cell = cells[node.ref.r]?.[node.ref.c];
        if (!cell) return { v: "" };
        const got = values[node.ref.r][node.ref.c];
        return got;
      }
      case "range": {
        const out = [];
        const r1 = Math.min(node.from.r, node.to.r), r2 = Math.max(node.from.r, node.to.r);
        const c1 = Math.min(node.from.c, node.to.c), c2 = Math.max(node.from.c, node.to.c);
        for (let r = r1; r <= r2; r++) {
          for (let c = c1; c <= c2; c++) {
            const cell = cells[r]?.[c];
            out.push(cell ? values[r][c] : { v: "" });
          }
        }
        return out;
      }
      case "neg": { const a = num(evalNode(node.args[0])); return { v: -a }; }
      case "pct": { const a = num(evalNode(node.args[0])); return { v: a / 100 }; }
      case "bin": {
        const a = evalNode(node.args[0]), b = evalNode(node.args[1]);
        switch (node.op) {
          case "+": return { v: num(a) + num(b) };
          case "-": return { v: num(a) - num(b) };
          case "*": return { v: num(a) * num(b) };
          case "/": if (num(b) === 0) throw new Error("#DIV/0!"); return { v: num(a) / num(b) };
          case "^": return { v: Math.pow(num(a), num(b)) };
        }
        break;
      }
      case "concat": {
        const a = evalNode(node.args[0]), b = evalNode(node.args[1]);
        return { v: str(a) + str(b) };
      }
      case "cmp": {
        const a = evalNode(node.args[0]), b = evalNode(node.args[1]);
        let res;
        if (node.op === "=") res = looseEq(a, b);
        else if (node.op === "<>") res = !looseEq(a, b);
        else {
          const [x, y] = comparable(a, b);
          if (node.op === "<") res = x < y;
          else if (node.op === "<=") res = x <= y;
          else if (node.op === ">") res = x > y;
          else res = x >= y;
        }
        return { v: res };
      }
      case "call": return callFn(node.name, node.args.map(evalNode));
    }
    throw new Error("bad node");
  }

  function callFn(name, args) {
    const flat = () => args.flat(Infinity).map((a) => (a && typeof a === "object" ? a : { v: a }));
    const nums = () => flat().filter((a) => typeof a.v === "number" && !a.err).map((a) => a.v);
    switch (name) {
      case "SUM": return { v: nums().reduce((s, x) => s + x, 0) };
      case "AVERAGE": case "AVG": { const n = nums(); return n.length ? { v: n.reduce((s, x) => s + x, 0) / n.length } : { v: "#DIV/0!", err: true }; }
      case "MIN": { const n = nums(); return n.length ? { v: Math.min(...n) } : { v: 0 }; }
      case "MAX": { const n = nums(); return n.length ? { v: Math.max(...n) } : { v: 0 }; }
      case "COUNT": return { v: nums().length };
      case "ABS": return { v: Math.abs(num(args[0])) };
      case "ROUND": { const a = num(args[0]), d = args.length > 1 ? num(args[1]) : 0; const f = Math.pow(10, d); return { v: Math.round(a * f) / f }; }
      case "FLOOR": return { v: Math.floor(num(args[0])) };
      case "CEILING": return { v: Math.ceil(num(args[0])) };
      case "SQRT": { const a = num(args[0]); if (a < 0) throw new Error("#NUM!"); return { v: Math.sqrt(a) }; }
      case "POWER": return { v: Math.pow(num(args[0]), num(args[1])) };
      case "MOD": { const b = num(args[1]); if (b === 0) throw new Error("#DIV/0!"); return { v: num(args[0]) % b }; }
      case "PI": return { v: Math.PI };
      case "IF": return truthy(args[0]) ? args[1] ?? { v: "" } : args[2] ?? { v: false };
      case "AND": return { v: flat().every(truthy) };
      case "OR": return { v: flat().some(truthy) };
      case "NOT": return { v: !truthy(args[0]) };
      case "CONCAT": case "CONCATENATE": return { v: flat().map(str).join("") };
      case "LEN": return { v: str(args[0]).length };
      case "UPPER": return { v: str(args[0]).toUpperCase() };
      case "LOWER": return { v: str(args[0]).toLowerCase() };
      case "TRIM": return { v: str(args[0]).trim() };
      case "LEFT": { const s = str(args[0]); const n = args.length > 1 ? num(args[1]) : 1; return { v: s.slice(0, Math.max(0, n)) }; }
      case "RIGHT": { const s = str(args[0]); const n = args.length > 1 ? num(args[1]) : 1; return { v: n > 0 ? s.slice(-n) : "" }; }
      case "MID": { const s = str(args[0]); const start = num(args[1]); const n = num(args[2]); return { v: s.slice(Math.max(0, start - 1), Math.max(0, start - 1) + Math.max(0, n)) }; }
      case "FIND": { const i = str(args[1]).indexOf(str(args[0])); if (i < 0) throw new Error("#VALUE!"); return { v: i + 1 }; }
      case "REPLACE": { const s = str(args[0]); const at = num(args[1]); const n = num(args[2]); const rep = str(args[3]); return { v: s.slice(0, at - 1) + rep + s.slice(at - 1 + n) }; }
      case "TODAY": return { v: new Date().toISOString().slice(0, 10) };
      case "NOW": return { v: new Date().toISOString().slice(11, 19) };
      case "TRUE": return { v: true };
      case "FALSE": return { v: false };
      case "RAND": return { v: Math.random() };
    }
    throw new Error(`#NAME? ${name}`);
  }

  return { values, order };
}

// ---------- coercion helpers ----------

function num(cell) {
  const v = cell && typeof cell === "object" ? cell.v : cell;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === "" || v == null) return 0;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error("#VALUE!");
  return n;
}
function str(cell) {
  const v = cell && typeof cell === "object" ? cell.v : cell;
  if (v == null) return "";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}
function truthy(cell) {
  const v = cell && typeof cell === "object" ? cell.v : cell;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toUpperCase() === "TRUE";
  return false;
}
function looseEq(a, b) {
  const av = a?.v, bv = b?.v;
  if (typeof av === "number" && typeof bv === "number") return av === bv;
  return String(av ?? "") === String(bv ?? "");
}
function comparable(a, b) {
  const av = a?.v, bv = b?.v;
  if (typeof av === "number" && typeof bv === "number") return [av, bv];
  return [String(av ?? ""), String(bv ?? "")];
}
function literalValue(raw) {
  const t = raw.trim();
  if (t === "") return { v: "" };
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(t)) return { v: Number(t) };
  if (/^-?\.[0-9]+$/.test(t)) return { v: Number(t) };
  if (/^(true|false)$/i.test(t)) return { v: /^true$/i.test(t) };
  return { v: raw };
}

export function formatNumber(n) {
  if (Number.isInteger(n)) return String(n);
  const s = String(Math.round(n * 1e10) / 1e10);
  return s;
}

/** Parse raw cell text: "=..." becomes an AST, else literal. */
export function parseCell(raw) {
  if (typeof raw !== "string" || !raw.startsWith("=")) return { raw };
  try {
    return { raw, ast: parse(tokenize(raw.slice(1))) };
  } catch (e) {
    return { raw, parseError: e.message };
  }
}
