import { PAGE } from "./page.js";

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const headers = { ...SECURITY_HEADERS };

    if (request.method !== "GET") {
      return json({ ok: false, error: "method_not_allowed" }, 405, headers);
    }
    if (url.pathname === "/") {
      return new Response(PAGE, {
        status: 200,
        headers: { ...headers, "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/healthz") {
      return json({ ok: true, app: "tabula", time: new Date().toISOString() }, 200, headers);
    }
    return json({ ok: false, error: "not_found" }, 404, headers);
  },
};

function json(body, status, base) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...base, "content-type": "application/json; charset=utf-8" },
  });
}
