import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const BASE = "https://tabula.example.workers.dev";

test("GET / serves the app shell", async () => {
  const res = await worker.fetch(new Request(BASE + "/"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  const html = await res.text();
  assert.match(html, /<title>Tabula — a spreadsheet with a real formula engine<\/title>/);
  assert.match(html, /id="sheet"|id="gridwrap"/);
  assert.match(html, /id="formula"/);
  assert.match(html, /name="viewport"/);
  assert.doesNotMatch(html, />undefined<|>null</); // guard against template leaks into markup
  assert.doesNotMatch(html, /<(script|link|img)[^>]+src=["']https?:/); // no external requests
});

test("GET /healthz reports ok as JSON", async () => {
  const res = await worker.fetch(new Request(BASE + "/healthz"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.app, "tabula");
  assert.ok(!Number.isNaN(Date.parse(body.time)));
});

test("unknown paths return a JSON 404", async () => {
  const res = await worker.fetch(new Request(BASE + "/nope"));
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, "not_found");
});

test("non-GET requests are rejected", async () => {
  const res = await worker.fetch(new Request(BASE + "/", { method: "POST" }));
  assert.equal(res.status, 405);
});
