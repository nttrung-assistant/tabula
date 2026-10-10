# Tabula — a spreadsheet with a real formula engine

A working spreadsheet in your browser. Type numbers, type formulas, wire cells
together, export CSV, share the whole sheet as a URL. No account, no server
state — the entire app is one Cloudflare Worker.

**Live demo → https://tabula.nttrung-assistant.workers.dev**

## What it does

- **Real formula engine** — a hand-written tokenizer, recursive-descent parser
  (precedence climbing) and evaluator. Not `eval()`, not regex soup: a proper
  AST with operator precedence, right-associative power, unary minus and
  postfix percent (`=50%*200`).
- **Cell references and ranges** — `=B2*C2`, `=SUM(D2:D6)`, `=AVERAGE(A1:A9)`.
- **Dependency-aware recalculation** — cells are evaluated in topological
  order; reference cycles are *detected* and reported as `#CYCLE` instead of
  hanging the tab.
- **28 functions** — `SUM AVG MIN MAX COUNT ABS ROUND FLOOR CEILING SQRT
  POWER MOD PI IF AND OR NOT CONCAT CONCATENATE LEN UPPER LOWER TRIM LEFT
  RIGHT MID FIND REPLACE TODAY NOW TRUE FALSE RAND`.
- **Errors that talk** — `#DIV/0!`, `#VALUE!`, `#NAME?`, `#CYCLE`, plus
  parse errors shown on the offending cell.
- **Spreadsheet UX** — click to select, type to edit, Enter/Tab commit,
  arrows to move, F2 re-edit, Del clears, name box jumps (`AA10` + Enter),
  formula bar mirrors the editor live.
- **Share by URL** — the whole sheet lives in the link (`#d=…`). Copy, send,
  open anywhere. State also autosaves to `localStorage`; links win.
- **CSV in and out** — import a file, export the *computed* values.
- Dark & light themes, follows the system.

## Stack

- One Cloudflare Worker (`src/index.js`) — serves the page, `/healthz`, JSON 404s.
- `src/formula.js` — the engine as a pure ES module (no DOM), unit-tested.
- `src/page.js` — the UI as one inline HTML string; the same engine source is
  inlined so the page needs zero external requests.
- Tests: Node's built-in runner (`node --test`) — 23 tests covering the
  tokenizer, parser precedence, every function family, error cases, cycle
  detection and the Worker's routing.

## Run it

```sh
npm install
npm test          # 23 tests
npm run dev       # local dev server at http://localhost:8787
npm run deploy    # deploy with wrangler
```

## Project layout

```
src/index.js          Worker entry: routing, security headers
src/formula.js        Tokenizer + parser + evaluator (pure module)
src/page.js           The whole UI as one inline HTML string
test/formula.test.js  Engine unit tests
test/worker.test.js   Fetch-handler tests
wrangler.toml         Worker config
```

## License

MIT — go balance your budget in a URL.
