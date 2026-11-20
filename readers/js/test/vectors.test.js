// Runs the published AI Terms test vectors (spec/ai-terms-vectors.json) against the built package, plus the
// reader's own helpers. `npm test` builds first. The robots.txt cases check a generator, which this reader is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allowedWithin, contentUsage, fetchTerms, freeAllowance, globMatch, parse, resolve, termsLink, validate } from "../dist/index.js";

const vectors = JSON.parse(readFileSync(new URL("../../../spec/ai-terms-vectors.json", import.meta.url), "utf8"));
let passed = 0;

test("validate vectors", () => {
  for (const c of vectors.validate) {
    const { errors } = validate(c.doc);
    assert.equal(errors.length === 0, c.valid, `${c.name}: ${errors.join(" | ")}`);
    if (c.error_contains) assert.ok(errors.join(" | ").includes(c.error_contains), `${c.name}: ${errors.join(" | ")}`);
    passed++;
  }
});

test("resolve vectors", () => {
  const terms = vectors.resolve.terms;
  for (const c of vectors.resolve.cases) {
    assert.equal(resolve(terms, c.use, c.path).access, c.access, c.name);
    passed++;
  }
});

test("aipref Content-Usage vectors", () => {
  for (const c of vectors.signals.content_usage) {
    assert.equal(contentUsage(c.terms ?? vectors.resolve.terms, c.path), c.value, c.name);
    passed++;
  }
});

test("every vector was run", () => {
  const total = vectors.validate.length + vectors.resolve.cases.length + vectors.signals.content_usage.length;
  assert.equal(passed, total);
  console.log(`${passed} of ${total} vectors pass`);
});

test("helpers", () => {
  assert.deepEqual(freeAllowance({ access: "deny", free: { requests: 5, per: "hour" } }), { requests: 5, per: "hour" });
  assert.equal(freeAllowance({ access: "allow", free: { requests: 5, per: "hour" } }), null);
  assert.equal(freeAllowance({ access: "paid", free: { requests: true, per: "day" } }), null);
  assert.equal(parse("<html>"), null);
  assert.equal(parse('{"hello": 1}'), null);
  assert.equal(allowedWithin({ access: "allow" }, 0), true);
  assert.equal(allowedWithin({ access: "deny" }, 100), false);
  assert.equal(allowedWithin({ access: "paid", price: { amount: "0.002", currency: "USD", per: "page" } }, 0.01), true);
  assert.equal(allowedWithin({ access: "paid", price: { amount: "5", currency: "USD", per: "page" } }, 0.01), false);
  assert.equal(allowedWithin({ access: "paid" }, 0.01), false);
  assert.equal(contentUsage({ default: "allow", uses: {} }), "train-ai=y, ai-use=y, search=y");
  assert.equal(contentUsage({ default: "deny", uses: { search: { access: "paid" } } }), "train-ai=n, ai-use=n");
  assert.equal(termsLink('</t>; rel="service", <https://x.example/terms>; rel="ai-terms"'), "https://x.example/terms");
  assert.equal(termsLink(null), null);
});

test("matching stays linear on hostile patterns", () => {
  const t0 = performance.now();
  assert.equal(globMatch("/*a*a*a*a*a*a*b", "/" + "a".repeat(5000)), false);
  assert.ok(performance.now() - t0 < 500);
});

test("fetchTerms: https only, no redirects, size cap, null on anything else", async () => {
  const seen = [];
  const doc = { ai_terms: "0.1", site: "https://ok.example", updated: "2026-11-20", default: "allow", uses: { search: { access: "allow" }, answer: { access: "allow" }, training: { access: "deny" }, agent: { access: "allow" } } };
  const fake = async (url, init) => {
    seen.push([url, init.redirect, init.headers["ai-purpose"]]);
    const host = new URL(url).hostname;
    if (host === "ok.example") return new Response(JSON.stringify(doc), { status: 200 });
    if (host === "moved.example") return new Response(null, { status: 301, headers: { location: "https://elsewhere.example/" } });
    if (host === "huge.example") return new Response(" ".repeat(200_000) + JSON.stringify(doc), { status: 200 });
    return new Response("nope", { status: 404 });
  };
  assert.deepEqual(await fetchTerms("ok.example", { fetch: fake, purpose: "training" }), doc);
  assert.deepEqual(seen[0], ["https://ok.example/.well-known/ai-terms", "manual", "training"]);
  assert.equal(await fetchTerms("http://ok.example", { fetch: fake }), null);
  assert.equal(await fetchTerms("https://moved.example", { fetch: fake }), null);
  assert.equal(await fetchTerms("https://huge.example", { fetch: fake }), null); // the file is past MAX_BYTES
  assert.equal(await fetchTerms("https://missing.example", { fetch: fake }), null);
  assert.equal(await fetchTerms("https://ok.example", { fetch: async () => { throw new Error("offline"); } }), null);
});
