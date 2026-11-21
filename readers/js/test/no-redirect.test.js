// fetchTerms never follows a redirect: every 3xx answer, to http or to https, gives null, and nothing is fetched from
// the redirect target. The draft (-03 section 4) requires every redirect followed to be https; following none meets that.
// A real loopback http server and Node's own fetch: fetchTerms builds only https URLs, so the injected fetch rewrites
// the origin to the loopback server and passes the reader's own request options (redirect, signal, headers) untouched.
// The Python reader has the same test (readers/python/test_vectors.py).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchTerms } from "../dist/index.js";

const TERMS = JSON.stringify({ ai_terms: "0.1", site: "https://example.com", updated: "2026-11-16", default: "allow",
  uses: { search: { access: "allow" }, answer: { access: "allow" }, training: { access: "allow" }, agent: { access: "allow" } } });

let server, port, answer, seen;
before(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === "/.well-known/ai-terms" && answer.code !== 200) {
      res.writeHead(answer.code, { location: `${answer.scheme}://127.0.0.1:${port}/elsewhere` });
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(TERMS);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
after(() => new Promise((r) => server.close(r)));

/** Sends fetchTerms' request to the loopback server, with the options fetchTerms chose. */
let init;
const loopback = (url, opts) => { init = opts; return fetch(String(url).replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${port}`), opts); };

async function run(code, scheme) {
  answer = { code, scheme }; seen = []; init = undefined;
  return fetchTerms("https://example.com", { fetch: loopback });
}

test("control: a 200 answer is read", async () => {
  const terms = await run(200, "");
  assert.equal(terms?.ai_terms, "0.1");
  assert.deepEqual(seen, ["/.well-known/ai-terms"]);
});

for (const code of [301, 302, 303, 307, 308]) {
  for (const scheme of ["http", "https"]) {
    test(`a ${code} to ${scheme} gives null and is not followed`, async () => {
      assert.equal(await run(code, scheme), null);
      assert.equal(init.redirect, "manual");
      assert.deepEqual(seen, ["/.well-known/ai-terms"], "the server saw only the one request, never the redirect target");
    });
  }
}

test("the harness can fail: with redirects followed, a 302 to http is read from its target", async () => {
  answer = { code: 302, scheme: "http" }; seen = [];
  const follow = (url, opts) => loopback(url, { ...opts, redirect: "follow" });
  const terms = await fetchTerms("https://example.com", { fetch: follow });
  assert.equal(terms?.ai_terms, "0.1");
  assert.deepEqual(seen, ["/.well-known/ai-terms", "/elsewhere"]);
});
