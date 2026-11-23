// Pay-per-crawl via AIPayGen, as Vercel Routing Middleware, for Vercel sites that are not Next.js
// (on Next.js, use the Next.js setup instead).
// 1. Save this file as middleware.js at the root of your project, next to package.json.
//    No package.json yet (a plain static site)? Create one containing: { "type": "module" }
// 2. Run: npm i @vercel/functions
// 3. In Vercel: Settings > Environment Variables, add AIPAYGEN_SECRET (your gateway secret), then redeploy.
import { next } from "@vercel/functions";

const GATEWAY = "https://aipaygen.com/g/YOUR_ROUTE_ID";
const AI_BOTS = /GPTBot|OAI\-SearchBot|ChatGPT\-User|ClaudeBot|Claude\-User|Claude\-SearchBot|anthropic\-ai|PerplexityBot|Perplexity\-User|GoogleOther|CCBot|Bytespider|Amazonbot|meta\-externalagent|FacebookBot|cohere\-ai|Diffbot|YouBot|MistralAI\-User|DuckAssistBot|PetalBot|Timpibot|ImagesiftBot|omgili|AI2Bot|ElevenlabsCrawler|ElevenlabsBot/i;

// AI crawlers that hide their name are caught by address: the IP lists OpenAI, Perplexity, DuckDuckGo, Common Crawl, Anthropic, Mistral and Amazon
// publish, collected daily at https://aipaygen.com/v1/ai_bot_ips
let AI_NETS = [], AI_NETS_AT = 0;
async function aiNetsLoad() {
  try {
    const r = await fetch("https://aipaygen.com/v1/ai_bot_ips?format=text", { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return;
    const nets = [];
    for (const c of (await r.text()).split("\n")) {
      const [a, n] = c.trim().split("/"), x = ipNum(a || "");
      if (!x) continue;
      const full = x[0] === 4 ? 32 : 128, len = n === undefined ? full : Number(n); // a bare address is one host
      if (!/^\d+$/.test(n === undefined ? "0" : n) || len > full) continue; // skip a bad line, keep the rest
      const s = BigInt(full - len);
      nets.push([x[0], s, x[1] >> s]);
    }
    if (nets.length) { AI_NETS = nets; AI_NETS_AT = Date.now(); }
  } catch {}
}
function ipNum(ip) {
  ip = ip.trim().replace(/^::ffff:(?=\d+\.)/i, "");
  if (ip.includes(".")) { const p = ip.split(".").map(Number); return p.length === 4 && p.every((x) => x >= 0 && x < 256) ? [4, p.reduce((a, x) => a * 256n + BigInt(x), 0n)] : null; }
  const [h, t] = ip.split("::"), H = h ? h.split(":") : [], T = t ? t.split(":") : [];
  const g = t === undefined ? H : [...H, ...Array(Math.max(0, 8 - H.length - T.length)).fill("0"), ...T];
  return g.length === 8 && g.every((x) => /^[0-9a-f]{1,4}$/i.test(x)) ? [6, g.reduce((a, x) => a * 65536n + BigInt(parseInt(x, 16)), 0n)] : null;
}
// Answers from the list in memory at once; a daily refresh runs in the background (wait keeps it alive on Workers).
function isAiIp(ip, wait) {
  if (Date.now() - AI_NETS_AT > 864e5) {
    AI_NETS_AT = Date.now() - 864e5 + 3e5; // one refresh at a time; if it fails, try again in 5 minutes
    const p = aiNetsLoad();
    if (wait) try { wait(p); } catch {}
  }
  const x = ip ? ipNum(ip) : null;
  return !!x && AI_NETS.some(([v, s, b]) => v === x[0] && x[1] >> s === b);
}

// Answer AI crawlers here with your price; only paid retries go to AIPayGen.
const [AIPAYGEN, ROUTE] = GATEWAY.split("/g/");
// The first "still installed" report is due 10 minutes after this process starts (so short-lived isolates send none), then daily.
// Read through hb(): a Worker has no clock at load (Date.now() is 0 in its global scope), so the 10 minutes start at the first request.
let HB_AT = 0;
function hb() { if (!HB_AT) HB_AT = Date.now() - 864e5 + 6e5; return HB_AT; }
let QUOTE = null, QUOTE_AT = 0, HITS = {}, PAGES = {}, TERMS = {}, HIT_N = 0, SENT_AT = 0, FAST = {}, FAST_N = 0, FREE_USED = {}, FREE_WIN = "";
// This site's AI Terms (what AI may do with its pages, per use; aipaygen.com/ai-terms), served at /.well-known/ai-terms.
// isAi: whether the request comes from a published AI crawler address. A verified crawler (its name and that address)
// reading this file is counted with the visits and sent in the same batched report: no request of its own.
async function aipaygenTerms(ua, isAi) {
  const m = ua ? String(ua).match(AI_BOTS) : null;
  try { if (m && isAi && isAi() && (m[0] in TERMS || Object.keys(TERMS).length < 50)) TERMS[m[0]] = (TERMS[m[0]] || 0) + 1; } catch {}
  try {
    const r = await fetch(AIPAYGEN + "/v1/gateway/terms/" + ROUTE, { signal: AbortSignal.timeout(3000) });
    if (r.ok) return new Response(await r.text(), { headers: { "content-type": "application/json", "cache-control": "public, max-age=900", "access-control-allow-origin": "*" } });
  } catch {}
  return null;
}
async function aipaygenQuote() {
  if (Date.now() - QUOTE_AT > 36e5) {
    // Set first: while AIPayGen can't be reached, one request tries again every 5 minutes and every
    // other crawler visit is served the page (or the last price) at once, without waiting on us.
    QUOTE_AT = Date.now() - 36e5 + 3e5;
    try {
      const r = await fetch(AIPAYGEN + "/v1/gateway/quote/" + ROUTE, { signal: AbortSignal.timeout(3000) });
      if (r.ok) { QUOTE = await r.json(); QUOTE_AT = Date.now(); }
    } catch {}
  }
  return QUOTE;
}
// verified: the crawler's name AND its address match the lists AI companies publish. Only verified
// crawlers get the site's free allowance (AI Terms "free"), so claiming a crawler's name earns nothing.
// opts.signed: a Web Bot Auth signature checked here (aipaygenWba); it gets the allowance only where the route turns
// that on (quote signed_free === true; anything else is off). opts.fake: a signature that failed for a known agent key.
async function aipaygen402(url, bot, path, verified, opts) {
  const q = await aipaygenQuote();
  // Counted as "<name> (fake)": a name whose operator publishes its addresses (the quote's checked_bots), from outside
  // the address list this process has loaded. Never before the list has loaded; names with no published list are
  // never called fake. One list covers every operator, so a name used from another AI company's addresses still
  // counts as real: fakes can be under-counted, never over-counted.
  const checked = !verified && bot !== "AI crawler (by IP)" && typeof AI_NETS !== "undefined" && AI_NETS.length > 0 && q && Array.isArray(q.checked_bots)
    ? q.checked_bots.find((b) => typeof b === "string" && b.toLowerCase() === String(bot).toLowerCase()) : undefined;
  const seen = opts && opts.fake ? bot + " (fake)" : checked ? checked + " (fake)" : bot;
  HITS[seen] = (HITS[seen] || 0) + 1; HIT_N++;
  if (PAGES[path] || Object.keys(PAGES).length < 300) PAGES[path] = (PAGES[path] || 0) + 1;
  if (!q || q.charge_mode === "off") return null; // report only: count the visit, serve the page
  // Bots this site lets in free (its route's settings, e.g. AI search in "training" mode): serve the page.
  if ((Array.isArray(q.free_bots) ? q.free_bots : []).some((b) => String(b).toLowerCase() === String(bot).toLowerCase())) return null;
  // Free allowance: this many pages per UTC hour or day for each verified crawler, then the price.
  // Counted separately by each server process or serverless instance: a site running several can give up to
  // that many times the allowance (never less), because the counts are not shared between them.
  const fa = q.free && typeof q.free === "object" ? q.free : null;
  if ((verified || (opts && opts.signed && q.signed_free === true)) && fa && fa.requests > 0) {
    const win = new Date().toISOString().slice(0, fa.per === "hour" ? 13 : 10);
    if (win !== FREE_WIN) { FREE_WIN = win; FREE_USED = {}; }
    const k = String(bot).toLowerCase();
    if (k in FREE_USED || Object.keys(FREE_USED).length < 200) {
      FREE_USED[k] = (FREE_USED[k] || 0) + 1;
      if (FREE_USED[k] <= fa.requests) return null;
    }
  }
  try {
    const quote = { x402Version: 2, error: "PAYMENT_REQUIRED", resource: { url, description: q.description, mimeType: "text/html" }, accepts: q.accepts,
      // The quote's x402 v2 extensions (AI Terms, ask before you buy), kept where the official SDK keeps them.
      ...(q.extensions && typeof q.extensions === "object" ? { extensions: q.extensions } : {}) };
    // The header is base64 of plain ASCII, so an accent, a dash or an emoji in a name can't break it.
    const ascii = JSON.stringify(quote).replace(/[^\x20-\x7e]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    return new Response(JSON.stringify({ ...quote, help: q.help }), {
      status: 402,
      headers: { "content-type": "application/json", "cache-control": "no-store", "payment-required": btoa(ascii),
        // AI Terms: the route's machine-readable terms, which a 402 MUST link. (No Content-Usage here: it describes
        // the content of a message, and a 402 carries the price, not the page.)
        ...(aipaygenSignals().link ? { link: aipaygenSignals().link } : {}) },
    });
  } catch { return null; } // never let a quote problem break the page
}
// What the terms say, in headers crawlers already read: Link rel="ai-terms" and the IETF aipref Content-Usage
// (e.g. "train-ai=n"). The Link on the 402 and on pages served to AI crawlers; Content-Usage on those pages only.
// Nothing while report-only.
function aipaygenSignals() {
  const q = QUOTE, h = {};
  if (q && typeof q.terms === "string" && /^https:[^\s<>"]+$/.test(q.terms)) h.link = "<" + q.terms + '>; rel="ai-terms"';
  if (q && typeof q.content_usage === "string" && /^[a-z-]+=[yn](, [a-z-]+=[yn]){0,5}$/.test(q.content_usage)) h["content-usage"] = q.content_usage;
  return h;
}
// The site's own Content-Usage combined with ours as IETF aipref combines preferences: for each category, n in either
// is n. The site's other members are kept as they are; categories it doesn't state are added from ours.
function aipaygenMergeUsage(own, ours) {
  if (!own) return ours;
  const mine = {}, out = [];
  for (const p of ours.split(",")) { const kv = p.trim().split("="); mine[kv[0]] = kv[1]; }
  for (const p of String(own).split(",")) {
    const t = p.trim(), k = t.split(/[=;]/)[0];
    if (!t) continue;
    if (k in mine) { out.push(mine[k] === "n" ? k + "=n" : t); delete mine[k]; } else out.push(t);
  }
  for (const k in mine) out.push(k + "=" + mine[k]);
  return out.join(", ");
}
// The page as served, with those headers added (a Link the site already sends is kept, ours appended).
function aipaygenSign(res) {
  const h = aipaygenSignals();
  if (!res || !Object.keys(h).length) return res;
  try {
    const r = new Response(res.body, res);
    if (h.link && !/rel="?ai-terms/i.test(r.headers.get("link") || "")) r.headers.append("link", h.link);
    if (h["content-usage"]) r.headers.set("content-usage", aipaygenMergeUsage(r.headers.get("content-usage"), h["content-usage"]));
    return r;
  } catch { return res; }
}
// Visit counts for your AI crawler report. The first visit of a fresh process is sent at once (a short-lived instance
// would lose it), then at most one small request a minute, or sooner after max_hits visits.
async function aipaygenReport(secret) {
  const every = (QUOTE && QUOTE.report) || { every_seconds: 60, max_hits: 500 };
  if (!secret) return;
  const now = Date.now();
  // Installed but quiet: one empty report when this process first sees traffic, then at most once a day, so your report
  // shows the setup is live before any AI crawler comes (it carries no visitor data: counts {}).
  if (!(HIT_N + FAST_N)) { if (now - hb() < 864e5) return; }
  else if (HIT_N < every.max_hits && now - SENT_AT < Math.max(60, every.every_seconds) * 1000) return;
  const pages = Object.fromEntries(Object.entries(PAGES).sort((a, b) => b[1] - a[1]).slice(0, 10));
  const fast = Object.fromEntries(Object.entries(FAST).sort((a, b) => b[1].times - a[1].times).slice(0, 20));
  const terms = Object.keys(TERMS).length ? { terms: TERMS } : {};
  const body = JSON.stringify(FAST_N ? { counts: HITS, paths: pages, fast, ...terms } : { counts: HITS, paths: pages, ...terms });
  HITS = {}; PAGES = {}; TERMS = {}; HIT_N = 0; SENT_AT = now; HB_AT = now; FAST = {}; FAST_N = 0;
  try {
    await fetch(AIPAYGEN + "/v1/gateway/hits/" + ROUTE, { method: "POST", headers: { "content-type": "application/json", "x-aipaygen-gateway-secret": secret }, body, signal: AbortSignal.timeout(5000) });
  } catch {}
}
// Fast readers: a browser user agent asking for many pages a minute and no images or stylesheets,
// the usual shape of a crawler in disguise. Only listed in your report (network /24 or /48 and user
// agent), never charged. Nothing is sent for normal visitors. The limit comes from the quote.
const SEEN = new Map(), ASSET = /\.(css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|map)$/i;
function aipaygenNet(ip) {
  ip = String(ip || "").trim().replace(/^::ffff:(?=\d+\.)/i, "");
  if (/^(10|127)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^(::1|f[cd]|fe80)/i.test(ip)) return null; // private: likely a proxy, not a visitor
  if (ip.includes(".")) { const p = ip.split("."); return p.length === 4 ? p.slice(0, 3).join(".") + ".0/24" : null; }
  const [h, t] = ip.split("::"), H = h ? h.split(":") : [], T = t ? t.split(":") : [];
  const g = t === undefined ? H : [...H, ...Array(Math.max(0, 8 - H.length - T.length)).fill("0"), ...T];
  return g.length === 8 && g.every((x) => /^[0-9a-f]{1,4}$/i.test(x)) ? g.slice(0, 3).map((x) => parseInt(x, 16).toString(16)).join(":") + "::/48" : null;
}
function aipaygenWatch(ip, path, ua, secret) {
  const net = aipaygenNet(ip), flush = () => (FAST_N || Date.now() - hb() >= 864e5 ? aipaygenReport(secret) : undefined);
  if (!net) return flush();
  const now = Date.now(), lim = (QUOTE && QUOTE.fast) || { pages: 60, seconds: 60 };
  let s = SEEN.get(ip);
  if (!s || now - s[0] > lim.seconds * 1000) {
    if (SEEN.size >= 5000) SEEN.delete(SEEN.keys().next().value);
    s = [now, 0, 0]; SEEN.delete(ip); SEEN.set(ip, s);
  }
  if (ASSET.test(path)) { s[2]++; return flush(); }
  if (++s[1] < lim.pages || s[2]) return flush();
  const f = FAST[net] || (FAST[net] = { pages: 0, times: 0, ua: String(ua || "").slice(0, 160) });
  f.pages = Math.max(f.pages, s[1]);
  if (s[1] === lim.pages) { f.times++; FAST_N++; }
  return flush(); // sent with the next batch (every few minutes), never per visit
}
// Signed AI agents: switched off here until it is confirmed on a deploy (Ed25519 support differs between runtimes).
const WBA_ENABLED = false;
// Signed AI agents (Web Bot Auth, IETF draft): an agent that signs its requests is counted under its own name, and a
// signature that fails for a key we know is counted as fake. Keys come from AIPayGen's hourly list of agents we can
// identify (that's not an endorsement); this code never fetches an agent's own address. A key newer than the list is
// "unchecked": the usual name and address rules apply, never "fake".
// Replay: a captured valid signature can be sent again, from any address, until it expires (at most about 5 minutes
// past its own expiry). Processes can't share a list of seen signatures, so a replay counts as that agent again. That
// only affects counts, and the free allowance (if the site turns it on for signed agents) is capped per hour or day.
let WBA_KEYS = null, WBA_AT = 0, WBA_EARLY = 0;
const WBA_SKEW = 300;
function wbaLoad(early, wait) {
  const now = Date.now();
  if (!(now - WBA_AT > 36e5 || (early && now - WBA_EARLY > 3e5))) return;
  if (early) WBA_EARLY = now;
  WBA_AT = Math.max(WBA_AT, now - 36e5 + 3e5); // one refresh at a time; if it fails, try again in 5 minutes
  const p = fetch(AIPAYGEN + "/v1/signed_agents", { signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? r.json() : null)).then((j) => {
    if (j && j.agents && typeof j.agents === "object") { WBA_KEYS = j.agents; WBA_AT = Date.now(); }
  }).catch(() => {});
  if (wait) try { wait(p); } catch {}
}
function wbaStr(v) {
  const s = String(v == null ? "" : v).trim();
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return null;
  let out = "";
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i], code = c.charCodeAt(0);
    if (code < 0x20 || code > 0x7e) return null;
    if (c === "\\") { const n = s[++i]; if (n !== '"' && n !== "\\") return null; out += n; }
    else if (c === '"') return null;
    else out += c;
  }
  return out;
}
function wbaInput(header) {
  if (!header || header.length > 4096) return null;
  const members = [];
  let depth = 0, quote = false, start = 0;
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (quote) { if (c === "\\") i++; else if (c === '"') quote = false; continue; }
    if (c === '"') quote = true; else if (c === "(") depth++; else if (c === ")") depth--; else if (c === "," && depth === 0) { members.push(header.slice(start, i)); start = i + 1; }
  }
  members.push(header.slice(start));
  for (const m of members) {
    const eq = m.indexOf("=");
    if (eq < 1) continue;
    const label = m.slice(0, eq).trim(), raw = m.slice(eq + 1).trim();
    if (!/^[a-z*][a-z0-9_.*-]*$/.test(label) || raw[0] !== "(") continue;
    const close = raw.indexOf(")");
    if (close < 0) continue;
    const components = [...raw.slice(1, close).matchAll(/"([^"\\]*)"/g)].map((x) => x[1]);
    const params = {};
    for (const p of raw.slice(close + 1).split(";").map((x) => x.trim()).filter(Boolean)) {
      const k = p.indexOf("=");
      if (k < 1) continue;
      const name = p.slice(0, k), val = p.slice(k + 1);
      if (/^-?\d{1,15}$/.test(val)) params[name] = Number(val);
      else { const sv = wbaStr(val); if (sv !== null) params[name] = sv; }
    }
    if (params.tag === "web-bot-auth") return { label, components, params, raw };
  }
  return null;
}
function wbaSig(header, label) {
  if (!header) return null;
  const m = new RegExp("(?:^|,)\\s*" + label.replace(/[.*]/g, "\\$&") + "=:([A-Za-z0-9+/=]{1,1000}):").exec(header);
  if (!m) return null;
  try { return Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)); } catch { return null; }
}
function wbaBase(url, method, get, input) {
  const u = new URL(url), lines = [];
  for (const c of input.components) {
    let v;
    if (c === "@authority") v = u.host.toLowerCase();
    else if (c === "@method") v = String(method || "GET").toUpperCase();
    else if (c === "@path") v = u.pathname || "/";
    else if (c === "@target-uri") v = u.toString();
    else if (c === "@scheme") v = u.protocol.replace(":", "");
    else if (c === "@query") v = u.search || "?";
    else if (c[0] === "@") return null;
    else { const h = get(c); v = h == null ? null : String(h).trim(); }
    if (v == null) return null;
    lines.push('"' + c + '": ' + v);
  }
  lines.push('"@signature-params": ' + input.raw);
  return lines.join("\n");
}
async function wbaEd25519(x, data, sig) {
  const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x }, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, sig, data);
}
// The verdict for a request, as lane E's shared vectors define it ("none", "verified", "unchecked", "invalid:<why>"),
// with the agent's name and whether its key is in our list (only then can a failure be called fake).
async function aipaygenWba(url, method, getHeader, wait, nowMs) {
  // Every header this reads is capped at 4096 characters: a longer one is treated as absent.
  const get = (h) => { const v = getHeader(h); return v == null ? null : String(v).length > 4096 ? null : String(v); };
  const input = wbaInput(get("signature-input")), agent = wbaStr(get("signature-agent"));
  if (!input || !agent || !input.components.includes("@authority") || !input.components.includes("signature-agent")) return { v: "none" };
  const { created, expires, keyid, alg } = input.params;
  if (typeof created !== "number" || typeof expires !== "number" || typeof keyid !== "string" || !keyid || (alg !== undefined && alg !== "ed25519")) return { v: "none" };
  let host;
  try { const a = new URL(agent); if (a.protocol !== "https:" || (a.port && a.port !== "443") || a.username || a.password) return { v: "none" }; host = a.hostname.toLowerCase(); } catch { return { v: "none" }; }
  const sig = wbaSig(get("signature"), input.label);
  if (!sig) return { v: "none" };
  wbaLoad(false, wait);
  const entry = WBA_KEYS && Object.prototype.hasOwnProperty.call(WBA_KEYS, host) ? WBA_KEYS[host] : null;
  const k = entry && Array.isArray(entry.keys) ? entry.keys.find((x) => x && x.kid === keyid && typeof x.x === "string") : null;
  const bot = entry && typeof entry.bot === "string" && /^[A-Za-z0-9 ._()-]{1,40}$/.test(entry.bot) ? entry.bot : null;
  const known = !!(k && bot);
  const t = Math.floor((nowMs || Date.now()) / 1000);
  if (created > t + WBA_SKEW) return { v: "invalid:not yet valid", bot, known };
  if (expires < t - WBA_SKEW || expires <= created) return { v: "invalid:expired", bot, known };
  if (!k) { if (entry) wbaLoad(true, wait); return { v: "unchecked", bot, known: false }; } // a key newer than our list
  const base = wbaBase(url, method, get, input);
  if (!base) return { v: "none" };
  let ok = false;
  try { ok = await (typeof WBA_ED25519 === "function" ? WBA_ED25519 : wbaEd25519)(k.x, new TextEncoder().encode(base), sig); } catch { ok = false; }
  return ok ? { v: "verified", bot, known } : { v: "invalid:bad signature", bot, known };
}
// What a snippet does with the verdict: a known agent signing correctly is that agent; a failure for a known key is
// "<agent> (fake)"; anything else changes nothing (the usual name and address rules).
function aipaygenSigned(w) {
  if (w && w.known && w.v === "verified") return { bot: w.bot, signed: true };
  if (w && w.known && w.v.startsWith("invalid:")) return { bot: w.bot, fake: true };
  return null;
}

function aipaygenForward(req, u) {
  const headers = {};
  for (const h of ["payment-signature", "x-payment", "user-agent", "accept", "accept-language"]) if (req.headers.get(h)) headers[h] = req.headers.get(h);
  return fetch(GATEWAY + u.pathname + u.search, { method: req.method === "HEAD" ? "HEAD" : "GET", headers, signal: AbortSignal.timeout(30000) })
    .catch(() => new Response('{"error":"PAYMENT_GATEWAY_UNAVAILABLE","message":"The payment service could not be reached. Nothing was charged. Try again shortly."}', { status: 503, headers: { "content-type": "application/json", "retry-after": "60", "cache-control": "no-store" } }));
}

// Fail open: an unexpected error here (or a malformed answer from AIPayGen) must never take the site down. The page is served
// as if this file were not here; a paid retry cannot be served free, so it gets a 503 "nothing was charged".
export default async function aipaygen(req, context) {
  try { return await aipaygenMain(req, context); } catch (e) {
    if (req.headers.get("payment-signature") || req.headers.get("x-payment")) return new Response('{"error":"PAYMENT_GATEWAY_UNAVAILABLE","message":"The payment service could not be reached. Nothing was charged. Try again shortly."}', { status: 503, headers: { "content-type": "application/json", "retry-after": "60", "cache-control": "no-store" } });
    return next();
  }
}
async function aipaygenMain(req, context) {
  const secret = process.env.AIPAYGEN_SECRET;
  // The gateway fetching a page it was paid for: serve it.
  if (secret && req.headers.get("x-aipaygen-gateway-secret") === secret) return next();
  const u = new URL(req.url);
  if (u.pathname === "/.well-known/ai-terms") { const t = await aipaygenTerms(req.headers.get("user-agent"), () => isAiIp(req.headers.get("x-real-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim())); if (t) return t; }
  // robots.txt is free for every crawler: it is how they learn your rules and find your terms.
  // Lines to add to it, written from your AI Terms (IETF aipref Content-Usage; training-only crawlers): https://aipaygen.com/v1/gateway/robots/YOUR_ROUTE_ID
  if (u.pathname === "/robots.txt") return next();
  // A crawler retrying with a payment: AIPayGen verifies it, fetches the page and settles to your wallet.
  if (req.headers.get("payment-signature") || req.headers.get("x-payment")) return aipaygenForward(req, u);
  const named = (req.headers.get("user-agent") || "").match(AI_BOTS);
  // Vercel puts the visitor's address in x-real-ip (and first in x-forwarded-for).
  const ip = req.headers.get("x-real-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  const signed = WBA_ENABLED ? aipaygenSigned(await aipaygenWba(req.url, req.method, (h) => req.headers.get(h), (p) => context.waitUntil(p))) : null;
  const bot = signed ? signed.bot : named ? named[0] : isAiIp(ip, (p) => context.waitUntil(p)) ? "AI crawler (by IP)" : null;
  if (!bot) { // people and search engines browse free; very fast page-only readers are listed in your report
    const w = aipaygenWatch(ip, u.pathname, req.headers.get("user-agent"), secret);
    if (w) context.waitUntil(w);
    return next();
  }
  const quote = await aipaygen402(req.url, bot, u.pathname, !signed && !!named && isAiIp(ip), signed);
  context.waitUntil(aipaygenReport(secret));
  // A crawler let in free still gets the terms Link and Content-Usage with the page.
  return quote || next({ headers: aipaygenSignals() });
}

export const config = { matcher: "/((?!_vercel/|favicon.ico).*)" };
