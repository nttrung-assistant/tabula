// Tabula — the whole app as one inline HTML string. No build step, no external requests.
// The inner script deliberately avoids backticks and ${ so it can live in this template literal.

const ENGINE = String.raw`
"use strict";
var TOKEN_RE = new RegExp([
  "\\s+",
  "[A-Za-z_][A-Za-z0-9_]*\\s*\\(",
  "\\$?[A-Za-z]{1,3}\\$?[0-9]{1,4}",
  "[0-9]+\\.[0-9]+|[0-9]+\\.(?![.0-9])|\\.[0-9]+|[0-9]+",
  '\"(?:[^\"]|\"\")*\"',
  "<>|<=|>=|<|>",
  "=",
  "[A-Za-z_][A-Za-z0-9_]*",
  "[+\\-*/^%&]",
  "[,:;]",
  "\\(|\\)"
].join("|"), "g");

function tokenize(src) {
  var tokens = [], last = 0, m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(src)) !== null) {
    if (m.index > last) throw new Error('Unexpected "' + src.slice(last, m.index).trim() + '"');
    var raw = m[0];
    if (!/^\s+$/.test(raw)) tokens.push({ type: kindOf(raw, src, m.index), raw: raw, at: m.index });
    last = TOKEN_RE.lastIndex;
  }
  if (last < src.length) throw new Error('Unexpected "' + src.slice(last).trim() + '"');
  return tokens;
}
function kindOf(raw, src, at) {
  if (/^\s+$/.test(raw)) return "ws";
  if (raw.slice(-1) === "(" && /[A-Za-z_]/.test(raw[0])) return "func";
  if (/^\$?[A-Za-z]{1,3}\$?[0-9]{1,4}$/.test(raw)) return "ref";
  if (/^[0-9.]/.test(raw)) return "num";
  if (raw.charAt(0) === '"') return "str";
  if (raw === "<>" || raw === "<=" || raw === ">=" || raw === "<" || raw === ">" || raw === "=") return "cmp";
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return "ident";
  if ("+-*/^%&".indexOf(raw) >= 0) return "op";
  if (",:;".indexOf(raw) >= 0) return "sep";
  if (raw === "(" || raw === ")") return raw;
  throw new Error('Bad token "' + raw + '"');
}

function parse(tokens) {
  var i = 0;
  function peek() { return tokens[i]; }
  function eat(type, raw) {
    var t = tokens[i];
    if (!t || t.type !== type || (raw !== undefined && t.raw !== raw))
      throw new Error("Expected " + (raw || type) + (t ? ', got "' + t.raw + '"' : " but formula ended"));
    i += 1; return t;
  }
  function cmp() { var l = concat(); while (peek() && peek().type === "cmp") { var op = eat("cmp").raw; l = { kind: "cmp", op: op, args: [l, concat()] }; } return l; }
  function concat() { var l = add(); while (peek() && peek().raw === "&") { eat("op"); l = { kind: "concat", args: [l, add()] }; } return l; }
  function add() { var l = mul(); while (peek() && (peek().raw === "+" || peek().raw === "-")) { var op = eat("op").raw; l = { kind: "bin", op: op, args: [l, mul()] }; } return l; }
  function mul() { var l = power(); while (peek() && (peek().raw === "*" || peek().raw === "/")) { var op = eat("op").raw; l = { kind: "bin", op: op, args: [l, power()] }; } return l; }
  function power() {
    var b = unary();
    while (peek() && peek().raw === "%") { eat("op"); b = { kind: "pct", args: [b] }; }
    if (peek() && peek().raw === "^") { eat("op"); return { kind: "bin", op: "^", args: [b, power()] }; }
    return b;
  }
  function unary() {
    if (peek() && peek().raw === "-") { eat("op"); return { kind: "neg", args: [unary()] }; }
    if (peek() && peek().raw === "+") { eat("op"); return unary(); }
    return atom();
  }
  function atom() {
    var t = peek();
    if (!t) throw new Error("Formula ended unexpectedly");
    if (t.type === "num") { eat("num"); return { kind: "lit", value: Number(t.raw) }; }
    if (t.type === "str") { eat("str"); return { kind: "lit", value: t.raw.slice(1, -1).replace(/""/g, '"') }; }
    if (t.type === "ident") {
      eat("ident");
      var up = t.raw.toUpperCase();
      if (up === "TRUE") return { kind: "lit", value: true };
      if (up === "FALSE") return { kind: "lit", value: false };
      throw new Error("#NAME? " + up);
    }
    if (t.type === "ref") {
      eat("ref");
      var from = normalizeRef(t.raw);
      if (peek() && peek().raw === ":") { eat("sep"); var t2 = eat("ref"); return { kind: "range", from: from, to: normalizeRef(t2.raw) }; }
      return { kind: "ref", ref: from };
    }
    if (t.type === "func") {
      var name = eat("func").raw.replace(/\s*\($/, "").toUpperCase();
      var args = [];
      if (!(peek() && peek().raw === ")")) {
        args.push(cmp());
        while (peek() && peek().type === "sep" && peek().raw !== ";") {
          eat("sep");
          if (peek() && peek().raw === ")") break;
          args.push(cmp());
        }
      }
      eat(")", ")");
      return { kind: "call", name: name, args: args };
    }
    if (t.raw === "(") { eat("(", "("); var inner = cmp(); eat(")", ")"); return inner; }
    throw new Error('Unexpected "' + t.raw + '"');
  }
  var ast = cmp();
  if (i !== tokens.length) throw new Error('Unexpected "' + tokens[i].raw + '"');
  return ast;
}

function normalizeRef(raw) {
  var m = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,4})$/.exec(raw);
  if (!m) throw new Error('Bad cell reference "' + raw + '"');
  var c = 0, s = m[1].toUpperCase(), k;
  for (k = 0; k < s.length; k++) c = c * 26 + (s.charCodeAt(k) - 64);
  return { c: c - 1, r: Number(m[2]) - 1 };
}
function refLabel(ref) {
  var c = ref.c + 1, s = "";
  while (c > 0) { var rem = (c - 1) % 26; s = String.fromCharCode(65 + rem) + s; c = Math.floor((c - 1) / 26); }
  return s + (ref.r + 1);
}

function collectRefs(node, out) {
  if (!node) return out;
  if (node.kind === "ref") out.push(node.ref);
  if (node.kind === "range") {
    var r1 = Math.min(node.from.r, node.to.r), r2 = Math.max(node.from.r, node.to.r);
    var c1 = Math.min(node.from.c, node.to.c), c2 = Math.max(node.from.c, node.to.c);
    for (var r = r1; r <= r2; r++) for (var c = c1; c <= c2; c++) out.push({ c: c, r: r });
  }
  var args = node.args || [];
  for (var k = 0; k < args.length; k++) collectRefs(args[k], out);
  return out;
}

function topoOrder(cells) {
  var WHITE = 0, GREY = 1, BLACK = 2;
  var color = new Map(), order = [];
  function key(r) { return r.c + "," + r.r; }
  function visit(ref, path) {
    var k = key(ref), st = color.get(k) || WHITE;
    if (st === BLACK) return;
    if (st === GREY) { var start = path.indexOf(k); for (var j = start; j < path.length; j++) color.set(path[j], BLACK); return; }
    color.set(k, GREY);
    var node = cells[ref.r] && cells[ref.r][ref.c];
    if (node && node.ast) {
      var deps = collectRefs(node.ast, []);
      for (var d = 0; d < deps.length; d++) {
        var dep = deps[d], dn = cells[dep.r] && cells[dep.r][dep.c];
        if (dn && dn.ast && (color.get(key(dep)) || WHITE) !== BLACK) visit(dep, path.concat(key(dep)));
      }
    }
    if ((color.get(k) || WHITE) === BLACK) return;
    color.set(k, BLACK);
    order.push(ref);
  }
  for (var r = 0; r < cells.length; r++)
    for (var c = 0; c < cells[r].length; c++)
      if (cells[r][c] && cells[r][c].ast) visit({ c: c, r: r }, [c + "," + r]);
  return order;
}

function evaluate(cells) {
  var EMPTY = { v: "" };
  var order = topoOrder(cells);
  var values = cells.map(function (row) { return row.map(function () { return EMPTY; }); });
  function key(r) { return r.c + "," + r.r; }
  var ordered = new Set(order.map(key));

  function evalNode(node) {
    switch (node.kind) {
      case "lit": return { v: node.value };
      case "ref": {
        var row = cells[node.ref.r];
        if (!row || !row[node.ref.c]) return { v: "" };
        return values[node.ref.r][node.ref.c];
      }
      case "range": {
        var out = [];
        var r1 = Math.min(node.from.r, node.to.r), r2 = Math.max(node.from.r, node.to.r);
        var c1 = Math.min(node.from.c, node.to.c), c2 = Math.max(node.from.c, node.to.c);
        for (var r = r1; r <= r2; r++) for (var c = c1; c <= c2; c++) {
          var row2 = cells[r];
          out.push(row2 && row2[c] ? values[r][c] : { v: "" });
        }
        return out;
      }
      case "neg": return { v: -num(evalNode(node.args[0])) };
      case "pct": return { v: num(evalNode(node.args[0])) / 100 };
      case "bin": {
        var a = evalNode(node.args[0]), b = evalNode(node.args[1]);
        switch (node.op) {
          case "+": return { v: num(a) + num(b) };
          case "-": return { v: num(a) - num(b) };
          case "*": return { v: num(a) * num(b) };
          case "/": if (num(b) === 0) throw new Error("#DIV/0!"); return { v: num(a) / num(b) };
          case "^": return { v: Math.pow(num(a), num(b)) };
        }
        break;
      }
      case "concat": return { v: str(evalNode(node.args[0])) + str(evalNode(node.args[1])) };
      case "cmp": {
        var x = evalNode(node.args[0]), y = evalNode(node.args[1]), res;
        if (node.op === "=") res = looseEq(x, y);
        else if (node.op === "<>") res = !looseEq(x, y);
        else {
          var pair = comparable(x, y);
          if (node.op === "<") res = pair[0] < pair[1];
          else if (node.op === "<=") res = pair[0] <= pair[1];
          else if (node.op === ">") res = pair[0] > pair[1];
          else res = pair[0] >= pair[1];
        }
        return { v: res };
      }
      case "call": {
        var args = [];
        for (var k = 0; k < node.args.length; k++) args.push(evalNode(node.args[k]));
        return callFn(node.name, args);
      }
    }
    throw new Error("bad node");
  }

  function callFn(name, args) {
    function flat() {
      var out = [];
      (function walk(xs) { for (var i = 0; i < xs.length; i++) { if (Array.isArray(xs[i])) walk(xs[i]); else out.push(xs[i]); } })(args);
      return out;
    }
    function nums() { return flat().filter(function (a) { return typeof a.v === "number" && !a.err; }).map(function (a) { return a.v; }); }
    switch (name) {
      case "SUM": { var s = 0, n = nums(); for (var i = 0; i < n.length; i++) s += n[i]; return { v: s }; }
      case "AVERAGE": case "AVG": { var n2 = nums(); if (!n2.length) throw new Error("#DIV/0!"); var t = 0; for (var j = 0; j < n2.length; j++) t += n2[j]; return { v: t / n2.length }; }
      case "MIN": { var n3 = nums(); if (!n3.length) return { v: 0 }; return { v: Math.min.apply(null, n3) }; }
      case "MAX": { var n4 = nums(); if (!n4.length) return { v: 0 }; return { v: Math.max.apply(null, n4) }; }
      case "COUNT": return { v: nums().length };
      case "ABS": return { v: Math.abs(num(args[0])) };
      case "ROUND": { var a0 = num(args[0]), d = args.length > 1 ? num(args[1]) : 0, f = Math.pow(10, d); return { v: Math.round(a0 * f) / f }; }
      case "FLOOR": return { v: Math.floor(num(args[0])) };
      case "CEILING": return { v: Math.ceil(num(args[0])) };
      case "SQRT": { var v0 = num(args[0]); if (v0 < 0) throw new Error("#NUM!"); return { v: Math.sqrt(v0) }; }
      case "POWER": return { v: Math.pow(num(args[0]), num(args[1])) };
      case "MOD": { var m0 = num(args[1]); if (m0 === 0) throw new Error("#DIV/0!"); return { v: num(args[0]) % m0 }; }
      case "PI": return { v: Math.PI };
      case "IF": return truthy(args[0]) ? (args.length > 1 ? args[1] : { v: "" }) : (args.length > 2 ? args[2] : { v: false });
      case "AND": return { v: flat().every(truthy) };
      case "OR": return { v: flat().some(truthy) };
      case "NOT": return { v: !truthy(args[0]) };
      case "CONCAT": case "CONCATENATE": return { v: flat().map(str).join("") };
      case "LEN": return { v: str(args[0]).length };
      case "UPPER": return { v: str(args[0]).toUpperCase() };
      case "LOWER": return { v: str(args[0]).toLowerCase() };
      case "TRIM": return { v: str(args[0]).trim() };
      case "LEFT": { var s1 = str(args[0]), n5 = args.length > 1 ? num(args[1]) : 1; return { v: s1.slice(0, Math.max(0, n5)) }; }
      case "RIGHT": { var s2 = str(args[0]), n6 = args.length > 1 ? num(args[1]) : 1; return { v: n6 > 0 ? s2.slice(-n6) : "" }; }
      case "MID": { var s3 = str(args[0]), st = num(args[1]), n7 = num(args[2]); return { v: s3.slice(Math.max(0, st - 1), Math.max(0, st - 1) + Math.max(0, n7)) }; }
      case "FIND": { var i0 = str(args[1]).indexOf(str(args[0])); if (i0 < 0) throw new Error("#VALUE!"); return { v: i0 + 1 }; }
      case "REPLACE": { var s4 = str(args[0]), at = num(args[1]), n8 = num(args[2]), rep = str(args[3]); return { v: s4.slice(0, at - 1) + rep + s4.slice(at - 1 + n8) }; }
      case "TODAY": return { v: new Date().toISOString().slice(0, 10) };
      case "NOW": return { v: new Date().toISOString().slice(11, 19) };
      case "TRUE": return { v: true };
      case "FALSE": return { v: false };
      case "RAND": return { v: Math.random() };
    }
    throw new Error("#NAME? " + name);
  }

  for (var lr = 0; lr < cells.length; lr++) {
    for (var lc = 0; lc < cells[lr].length; lc++) {
      var ln = cells[lr][lc];
      if (!ln) continue;
      if (!ln.ast) {
        values[lr][lc] = ln.parseError
          ? { v: ("#ERROR " + ln.parseError).slice(0, 60), err: true }
          : literalValue(ln.raw);
      }
    }
  }
  for (var oi = 0; oi < order.length; oi++) {
    var ref = order[oi], node = cells[ref.r] && cells[ref.r][ref.c];
    if (!node || !node.ast) continue;
    try { values[ref.r][ref.c] = evalNode(node.ast); }
    catch (e) { values[ref.r][ref.c] = { v: ("#ERROR " + e.message).slice(0, 60), err: true }; }
  }
  for (var r = 0; r < cells.length; r++) {
    for (var c = 0; c < cells[r].length; c++) {
      var n9 = cells[r][c];
      if (n9 && n9.ast && !ordered.has(c + "," + r)) values[r][c] = { v: "#CYCLE", err: true };
    }
  }
  return { values: values, order: order };
}

function num(cell) {
  var v = cell && typeof cell === "object" ? cell.v : cell;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === "" || v == null) return 0;
  var n = Number(v);
  if (Number.isNaN(n)) throw new Error("#VALUE!");
  return n;
}
function str(cell) {
  var v = cell && typeof cell === "object" ? cell.v : cell;
  if (v == null) return "";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}
function truthy(cell) {
  var v = cell && typeof cell === "object" ? cell.v : cell;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toUpperCase() === "TRUE";
  return false;
}
function looseEq(a, b) {
  var av = a && a.v, bv = b && b.v;
  if (typeof av === "number" && typeof bv === "number") return av === bv;
  return String(av == null ? "" : av) === String(bv == null ? "" : bv);
}
function comparable(a, b) {
  var av = a && a.v, bv = b && b.v;
  if (typeof av === "number" && typeof bv === "number") return [av, bv];
  return [String(av == null ? "" : av), String(bv == null ? "" : bv)];
}
function literalValue(raw) {
  var t = String(raw).trim();
  if (t === "") return { v: "" };
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(t) || /^-?\.[0-9]+$/.test(t)) return { v: Number(t) };
  if (/^(true|false)$/i.test(t)) return { v: /^true$/i.test(t) };
  return { v: raw };
}
function formatNumber(n) {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1e10) / 1e10);
}
function parseCell(raw) {
  if (typeof raw !== "string" || raw.charAt(0) !== "=") return { raw: raw };
  try { return { raw: raw, ast: parse(tokenize(raw.slice(1))) }; }
  catch (e) { return { raw: raw, parseError: e.message }; }
}
`;

const APP = String.raw`
"use strict";
var ROWS = 40, COLS = 26;
var data = new Map();      // "A1" -> raw string
var parsed = new Map();    // "A1" -> {raw, ast?, parseError?}
var values = [];           // last computed 2D values
var sel = { r: 0, c: 0 };
var editing = false;
var dirty = false;

var grid, formulaInput, nameBox, statusBar;

function key(r, c) { return refLabel({ r: r, c: c }); }
function labelOf(r, c) { return refLabel({ r: r, c: c }); }

function colLabel(c) {
  var n = c + 1, s = "";
  while (n > 0) { var rem = (n - 1) % 26; s = String.fromCharCode(65 + rem) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function buildGrid() {
  var html = ['<table id="sheet"><thead><tr><th class="corner"></th>'];
  for (var c = 0; c < COLS; c++) html.push('<th class="colh" data-c="' + c + '">' + colLabel(c) + "</th>");
  html.push("</tr></thead><tbody>");
  for (var r = 0; r < ROWS; r++) {
    html.push('<tr><th class="rowh" data-r="' + r + '">' + (r + 1) + "</th>");
    for (var c2 = 0; c2 < COLS; c2++) {
      html.push('<td class="cell" id="cell-' + r + "-" + c2 + '" data-r="' + r + '" data-c="' + c2 + '"><span class="v"></span></td>');
    }
    html.push("</tr>");
  }
  html.push("</tbody></table>");
  document.getElementById("gridwrap").innerHTML = html.join("");
  grid = document.getElementById("sheet");
  grid.addEventListener("mousedown", onGridMouseDown);
  grid.addEventListener("dblclick", onGridDblClick);
}

function parseAll() {
  parsed.clear();
  data.forEach(function (raw, k) {
    var m = /^([A-Z]+)([0-9]+)$/.exec(k);
    if (!m) return;
    parsed.set(k, parseCell(raw));
  });
}

function recompute() {
  parseAll();
  var cells = [];
  var maxR = 0, maxC = 0;
  parsed.forEach(function (p, k) {
    var m = /^([A-Z]+)([0-9]+)$/.exec(k);
    var ref = normalizeRef(k);
    if (ref.r > maxR) maxR = ref.r;
    if (ref.c > maxC) maxC = ref.c;
  });
  for (var r = 0; r <= Math.max(maxR, ROWS - 1); r++) {
    var row = [];
    for (var c = 0; c <= Math.max(maxC, COLS - 1); c++) row.push(parsed.get(labelOf(r, c)) || null);
    cells.push(row);
  }
  var res = evaluate(cells);
  values = res.values;
  renderValues();
  var errCount = 0;
  values.forEach(function (row) { row.forEach(function (v) { if (v && v.err) errCount++; }); });
  var fCount = 0; parsed.forEach(function (p) { if (p.ast) fCount++; });
  statusBar.textContent = fCount + " formula" + (fCount === 1 ? "" : "s") + " · " +
    (errCount === 0 ? "no errors" : errCount + " error" + (errCount === 1 ? "" : "s")) +
    " · " + COLS + " cols × " + ROWS + " rows";
}

function renderValues() {
  for (var r = 0; r < ROWS; r++) {
    for (var c = 0; c < COLS; c++) {
      var td = document.getElementById("cell-" + r + "-" + c);
      if (!td) continue;
      var span = td.firstChild;
      var k = labelOf(r, c);
      var raw = data.get(k);
      var p = parsed.get(k);
      var v = values[r] ? values[r][c] : null;
      td.classList.toggle("formula", !!(p && p.ast));
      td.classList.toggle("err", !!(v && v.err) || !!(p && p.parseError));
      if (raw === undefined) { span.textContent = ""; td.title = ""; continue; }
      if (p && p.ast) {
        span.textContent = v ? display(v) : "";
        td.title = raw;
      } else if (p && p.parseError) {
        span.textContent = "#" + p.parseError;
        td.title = raw + " — " + p.parseError;
      } else {
        span.textContent = raw;
        td.title = "";
      }
    }
  }
}

function display(v) {
  if (v.err) return v.v;
  if (typeof v.v === "boolean") return v.v ? "TRUE" : "FALSE";
  if (typeof v.v === "number") return formatNumber(v.v);
  return String(v.v);
}

function selectCell(r, c, openEditor) {
  if (editing) commitEdit(false);
  sel = { r: Math.max(0, Math.min(ROWS - 1, r)), c: Math.max(0, Math.min(COLS - 1, c)) };
  var old = grid.querySelector("td.sel");
  if (old) old.classList.remove("sel");
  var td = document.getElementById("cell-" + sel.r + "-" + sel.c);
  if (td) { td.classList.add("sel"); td.scrollIntoView({ block: "nearest", inline: "nearest" }); }
  nameBox.value = labelOf(sel.r, sel.c);
  formulaInput.value = data.get(labelOf(sel.r, sel.c)) || "";
  if (openEditor) startEdit("");
}

function startEdit(initial) {
  if (editing) return;
  editing = true;
  var td = document.getElementById("cell-" + sel.r + "-" + sel.c);
  td.classList.add("editing");
  var input = document.createElement("input");
  input.id = "editor";
  input.value = initial !== "" ? initial : (data.get(labelOf(sel.r, sel.c)) || "");
  td.textContent = "";
  td.appendChild(input);
  input.focus();
  if (initial === "") input.select();
  input.addEventListener("keydown", onEditorKey);
  input.addEventListener("input", function () { formulaInput.value = input.value; });
  formulaInput.value = input.value;
}

function commitEdit(move) {
  if (!editing) return;
  var input = document.getElementById("editor");
  var td = document.getElementById("cell-" + sel.r + "-" + sel.c);
  var val = input ? input.value : "";
  td.classList.remove("editing");
  td.textContent = "";
  var span = document.createElement("span");
  span.className = "v";
  td.appendChild(span);
  editing = false;
  setCell(labelOf(sel.r, sel.c), val);
  if (move === "down") selectCell(sel.r + 1, sel.c);
  else if (move === "right") selectCell(sel.r, sel.c + 1);
  else selectCell(sel.r, sel.c);
}

function cancelEdit() {
  if (!editing) return;
  var td = document.getElementById("cell-" + sel.r + "-" + sel.c);
  td.classList.remove("editing");
  td.textContent = "";
  var span = document.createElement("span");
  span.className = "v";
  td.appendChild(span);
  editing = false;
  formulaInput.value = data.get(labelOf(sel.r, sel.c)) || "";
}

function setCell(k, raw) {
  if (raw === "" || raw == null) data.delete(k);
  else data.set(k, raw);
  recompute();
  saveLocal();
  syncHash();
}

function onGridMouseDown(e) {
  var td = e.target.closest("td.cell");
  if (!td) return;
  e.preventDefault();
  selectCell(Number(td.dataset.r), Number(td.dataset.c));
}
function onGridDblClick(e) {
  var td = e.target.closest("td.cell");
  if (!td) return;
  selectCell(Number(td.dataset.r), Number(td.dataset.c));
  startEdit("");
}

function onEditorKey(e) {
  if (e.key === "Enter") { e.preventDefault(); commitEdit("down"); }
  else if (e.key === "Tab") { e.preventDefault(); commitEdit("right"); }
  else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
}

function onKey(e) {
  if (editing) return;
  if (e.target === formulaInput || e.target === nameBox) return;
  var r = sel.r, c = sel.c;
  switch (e.key) {
    case "ArrowUp": e.preventDefault(); selectCell(r - 1, c); return;
    case "ArrowDown": e.preventDefault(); selectCell(r + 1, c); return;
    case "ArrowLeft": e.preventDefault(); selectCell(r, c - 1); return;
    case "ArrowRight": e.preventDefault(); selectCell(r, c + 1); return;
    case "Tab": e.preventDefault(); selectCell(r, c + (e.shiftKey ? -1 : 1)); return;
    case "Enter": case "F2": e.preventDefault(); startEdit(""); return;
    case "Delete": case "Backspace":
      e.preventDefault();
      setCell(labelOf(sel.r, sel.c), "");
      selectCell(sel.r, sel.c);
      return;
  }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    startEdit(e.key);
  }
}

// ---------- persistence ----------

function saveLocal() {
  try {
    var obj = {};
    data.forEach(function (v, k) { obj[k] = v; });
    localStorage.setItem("tabula", JSON.stringify(obj));
  } catch (e) { /* private mode */ }
}

function loadLocal() {
  try {
    var s = localStorage.getItem("tabula");
    if (!s) return null;
    return JSON.parse(s);
  } catch (e) { return null; }
}

function syncHash() {
  if (!data.size) { history.replaceState(null, "", location.pathname); return; }
  var parts = [];
  data.forEach(function (v, k) { parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v)); });
  history.replaceState(null, "", "#d=" + encodeURIComponent(parts.join("~")));
}

function loadHash() {
  var m = /#d=(.+)$/.exec(location.hash);
  if (!m) return null;
  try {
    var obj = {};
    m[1].split("~").forEach(function (pair) {
      var i = pair.indexOf("=");
      if (i < 1) return;
      obj[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
    });
    return obj;
  } catch (e) { return null; }
}

function loadFrom(obj) {
  data.clear();
  for (var k in obj) if (/^[A-Z]{1,3}[0-9]{1,4}$/.test(k)) data.set(k, String(obj[k]));
  recompute();
}

// ---------- CSV ----------

function exportCsv() {
  var maxR = -1, maxC = -1;
  data.forEach(function (v, k) { var ref = normalizeRef(k); if (ref.r > maxR) maxR = ref.r; if (ref.c > maxC) maxC = ref.c; });
  var lines = [];
  for (var r = 0; r <= maxR; r++) {
    var row = [];
    for (var c = 0; c <= maxC; c++) {
      var v = values[r] ? values[r][c] : { v: "" };
      var s = display(v);
      if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
      row.push(s);
    }
    lines.push(row.join(","));
  }
  var blob = new Blob([lines.join("\n")], { type: "text/csv" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "tabula.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

function importCsv(text) {
  data.clear();
  var rows = text.replace(/\r/g, "").split("\n");
  for (var r = 0; r < rows.length && r < ROWS; r++) {
    var cells = parseCsvLine(rows[r]);
    for (var c = 0; c < cells.length && c < COLS; c++) {
      if (cells[c] !== "") {
        var v = cells[c];
        if (/^=/.test(v) && !/^='/.test(v)) v = "'" + v;
        data.set(labelOf(r, c), v);
      }
    }
  }
  recompute(); saveLocal(); syncHash();
}

function parseCsvLine(line) {
  var out = [], cur = "", inQ = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// ---------- sample ----------

var SAMPLE = {
  A1: "Item", B1: "Qty", C1: "Unit $", D1: "Total",
  A2: "Mechanical keyboard", B2: "2", C2: "89.5", D2: "=B2*C2",
  A3: "27\" monitor", B3: "1", C3: "249", D3: "=B3*C3",
  A4: "USB-C dock", B4: "3", C4: "39", D4: "=B4*C4",
  A5: "Desk lamp", B5: "1", C5: "25.25", D5: "=B5*C5",
  A6: "Cable kit", B6: "4", C6: "6.5", D6: "=B6*C6",
  A8: "Subtotal", B8: "=SUM(D2:D6)",
  A9: "VAT 10%", B9: "=ROUND(B8*10%,2)",
  A10: "Grand total", B10: "=B8+B9",
  A12: "Best line item", B12: "=MAX(D2:D6)",
  A13: "Lines counted", B13: "=COUNT(D2:D6)",
  A14: "Budget ok?", B14: '=IF(B10<=500,"YES","NO")'
};

function boot() {
  grid = null;
  buildGrid();
  formulaInput = document.getElementById("formula");
  nameBox = document.getElementById("namebox");
  statusBar = document.getElementById("status");

  document.getElementById("app").addEventListener("keydown", onKey);
  formulaInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      setCell(labelOf(sel.r, sel.c), formulaInput.value);
      selectCell(Math.min(ROWS - 1, sel.r + 1), sel.c);
      document.getElementById("app").focus();
    } else if (e.key === "Escape") {
      formulaInput.value = data.get(labelOf(sel.r, sel.c)) || "";
      document.getElementById("app").focus();
    }
  });
  nameBox.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    var m = /^([A-Za-z]{1,3})([0-9]{1,4})$/.exec(nameBox.value.trim());
    if (m) selectCell(Number(m[2]) - 1, colIndex(m[1].toUpperCase()));
    else nameBox.value = labelOf(sel.r, sel.c);
  });
  document.getElementById("theme").addEventListener("click", toggleTheme);
  document.getElementById("sample").addEventListener("click", function () { loadFrom(SAMPLE); });
  document.getElementById("clear").addEventListener("click", function () { data.clear(); recompute(); saveLocal(); syncHash(); selectCell(0, 0); });
  document.getElementById("csvout").addEventListener("click", exportCsv);
  document.getElementById("csvin").addEventListener("change", function (e) {
    var f = e.target.files[0];
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () { importCsv(String(rd.result)); };
    rd.readAsText(f);
    e.target.value = "";
  });
  document.getElementById("copylink").addEventListener("click", function () {
    syncHash();
    var url = location.href;
    if (navigator.clipboard) navigator.clipboard.writeText(url);
    var b = document.getElementById("copylink");
    var t = b.textContent;
    b.textContent = "Copied ✓";
    setTimeout(function () { b.textContent = t; }, 1200);
  });

  var hash = loadHash();
  var local = loadLocal();
  if (hash) loadFrom(hash);
  else if (local && Object.keys(local).length) loadFrom(local);
  else loadFrom(SAMPLE);
  if (!hash && (!local || !Object.keys(local).length)) saveLocal();

  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
    document.documentElement.classList.add("light");
  }
  selectCell(0, 0);
  document.getElementById("app").focus();
}

function colIndex(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n - 1;
}

function toggleTheme() {
  document.documentElement.classList.toggle("light");
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
`;

const CSS = String.raw`
:root {
  --bg: #0d1117; --panel: #161b22; --border: #30363d; --text: #e6edf3;
  --dim: #8b949e; --accent: #58a6ff; --sel: #1f6feb33; --head: #21262d;
  --err: #f85149; --good: #3fb950; --formula: #bc8cff;
}
html.light {
  --bg: #ffffff; --panel: #f6f8fa; --border: #d0d7de; --text: #1f2328;
  --dim: #656d76; --accent: #0969da; --sel: #0969da22; --head: #f6f8fa;
  --err: #cf222e; --good: #1a7f37; --formula: #8250df;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg); color: var(--text);
  font: 14px/1.45 ui-sans-serif, system-ui, "Segoe UI", Helvetica, Arial, sans-serif;
  min-height: 100vh;
}
#app { outline: none; padding: 16px; max-width: 1200px; margin: 0 auto; }
header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
h1 span { color: var(--accent); }
.tag { color: var(--dim); font-size: 12.5px; }
.spacer { flex: 1; }
button {
  background: var(--panel); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 5px 10px; font: inherit; font-size: 12.5px; cursor: pointer;
}
button:hover { border-color: var(--accent); color: var(--accent); }
.bar {
  display: flex; align-items: center; gap: 8px; background: var(--panel);
  border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; margin-bottom: 10px;
}
#namebox {
  width: 64px; text-align: center; background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px; padding: 5px 4px; font: 600 13px ui-monospace, monospace;
}
#formula {
  flex: 1; background: var(--bg); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 5px 8px; font: 13px ui-monospace, "SF Mono", Menlo, monospace;
}
#formula:focus, #namebox:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.fx { color: var(--dim); font: italic 600 13px ui-serif, Georgia, serif; }
#gridwrap { overflow: auto; border: 1px solid var(--border); border-radius: 8px; max-height: 68vh; }
#sheet { border-collapse: separate; border-spacing: 0; font-variant-numeric: tabular-nums; }
#sheet th {
  background: var(--head); color: var(--dim); font: 600 11.5px ui-monospace, monospace;
  border-right: 1px solid var(--border); border-bottom: 1px solid var(--border);
  padding: 4px 8px; position: sticky; z-index: 2; user-select: none; text-align: center;
}
#sheet thead th { top: 0; }
#sheet .corner { left: 0; z-index: 3; }
#sheet .rowh { left: 0; }
#sheet td {
  min-width: 96px; max-width: 96px; width: 96px; height: 26px;
  border-right: 1px solid var(--border); border-bottom: 1px solid var(--border);
  padding: 3px 7px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  cursor: cell; background: var(--bg);
}
#sheet td.formula .v { color: var(--formula); }
#sheet td.err { color: var(--err); font-weight: 600; }
#sheet td.sel {
  outline: 2px solid var(--accent); outline-offset: -2px;
  background: var(--sel);
}
#sheet td.editing { padding: 0; overflow: visible; }
#editor {
  width: 100%; height: 100%; border: none; background: var(--bg); color: var(--text);
  font: 13px ui-monospace, monospace; padding: 3px 6px; outline: none;
}
#status { color: var(--dim); font-size: 12px; margin-top: 8px; }
details.help { margin-top: 14px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; }
details.help summary { cursor: pointer; font-weight: 600; font-size: 13px; color: var(--accent); }
details.help .cols { columns: 2; gap: 24px; margin-top: 10px; font-size: 12.5px; color: var(--dim); }
details.help code { color: var(--text); background: var(--bg); padding: 1px 5px; border-radius: 4px; font-size: 11.5px; }
details.help p { margin: 6px 0; }
footer { margin-top: 16px; color: var(--dim); font-size: 12px; }
footer a { color: var(--accent); text-decoration: none; }
@media (max-width: 720px) { #sheet td { min-width: 72px; max-width: 72px; width: 72px; } }
`;

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tabula — a spreadsheet with a real formula engine</title>
<style>${CSS}</style>
</head>
<body>
<div id="app" tabindex="0">
  <header>
    <h1>Tabula<span>.</span></h1>
    <span class="tag">a spreadsheet with a real formula engine — no account, lives in your URL</span>
    <span class="spacer"></span>
    <button id="sample">Sample</button>
    <label style="position:relative;overflow:hidden;display:inline-block">
      <button>Import CSV</button>
      <input id="csvin" type="file" accept=".csv,text/csv" style="position:absolute;inset:0;opacity:0;cursor:pointer">
    </label>
    <button id="csvout">Export CSV</button>
    <button id="copylink">Copy link</button>
    <button id="clear">Clear</button>
    <button id="theme" title="Toggle theme">◐</button>
  </header>
  <div class="bar">
    <input id="namebox" value="A1" aria-label="cell name">
    <span class="fx">fx</span>
    <input id="formula" placeholder="Type a value or =SUM(A1:A9) …" aria-label="formula bar" autocomplete="off" spellcheck="false">
  </div>
  <div id="gridwrap"></div>
  <div id="status"></div>
  <details class="help">
    <summary>What it supports</summary>
    <div class="cols">
      <p><code>=B2*C2</code> arithmetic <code>+ - * / ^ %</code>, unary minus, postfix <code>50%</code>.</p>
      <p><code>=SUM(D2:D6)</code> ranges, <code>=A1&amp;B1</code> concatenation.</p>
      <p><code>=IF(B10&gt;=500,"YES","NO")</code> conditionals with <code>AND OR NOT</code>.</p>
      <p><code>AVG MIN MAX COUNT ABS ROUND FLOOR CEILING SQRT POWER MOD PI RAND</code></p>
      <p><code>CONCAT LEN UPPER LOWER TRIM LEFT RIGHT MID FIND REPLACE</code></p>
      <p><code>TODAY() NOW() TRUE() FALSE()</code> · literals: <code>42 3.14 "text" TRUE</code></p>
      <p>Errors surface as <code>#DIV/0!</code> <code>#VALUE!</code> <code>#NAME?</code> <code>#CYCLE</code>.</p>
      <p>Cross-sheet-free, zero-backend: <b>formulas recalculate topologically</b> — edit any cell and only dependents change order, cycles are detected, not crashed on.</p>
    </div>
  </details>
  <footer>Tabula runs entirely in your browser as a single Cloudflare Worker ·
  keyboard: arrows to move · type to edit · Enter/Tab commit · F2 re-edit · Del clears ·
  <a href="https://github.com/nttrung-assistant/tabula">source on GitHub</a></footer>
</div>
<script>${ENGINE}</script>
<script>${APP}</script>
</body>
</html>
`;
