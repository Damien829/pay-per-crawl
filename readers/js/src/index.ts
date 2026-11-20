/**
 * AI Terms 0.1 reader for JavaScript and TypeScript. No dependencies; runs in Node 18+, Deno, Bun, browsers and
 * edge runtimes (it needs only fetch, URL and TextEncoder).
 *
 * AI Terms (https://aipaygen.com/ai-terms, draft-ovalles-ai-terms) is a JSON file at /.well-known/ai-terms where a
 * site says, per use, what AI may do with its pages: allow, paid (with a price) or deny.
 *
 *   import { fetchTerms, resolve, allowedWithin } from "ai-terms";
 *   const terms = await fetchTerms("https://example.com");   // null when the site publishes none
 *   if (terms) {
 *     const rule = resolve(terms, "agent", "/blog/post");
 *     if (!allowedWithin(rule, 0.01)) throw new Error("not allowed at my price");
 *   }
 *   // and say what you are doing on every request: { "AI-Purpose": "agent" }
 *
 * The matching, resolution, validation and aipref derivation are taken from the reference implementation (the
 * AIPayGen gateway's aiterms.ts and aisignals.ts) and checked against the published test vectors. License: MIT.
 */

export const VERSION = "0.1";
export const USES = ["search", "answer", "training", "agent"] as const;
export type Use = (typeof USES)[number];
export type Access = "allow" | "paid" | "deny";
export interface Price { amount: string; currency: "USD"; per: "page" | "request" }
export interface FreeAllowance { requests: number; per: "hour" | "day" }
export interface UseTerms { access: Access; price?: Price; attribution?: "required" | "requested" | "none"; free?: FreeAllowance }
export interface Payment { protocol: "x402"; version?: number; endpoint: string; network?: string; asset?: string }
export interface AiTerms {
  ai_terms: string;
  site: string;
  updated: string;
  uses: Record<Use, UseTerms>;
  default: Access;
  paths?: { match: string; uses: Partial<Record<Use, UseTerms>>; payment?: Payment }[];
  identity?: { verify?: string[]; unverified?: "treated-as-claimed" | "treated-as-unidentified" };
  purpose_header?: "AI-Purpose";
  payment?: Payment;
  receipts?: string;
  preview?: { shows?: ("title" | "description" | "excerpt" | "words")[]; delivery: "must-match" | "per-quote" | "not-checked"; described_quote?: string };
  report_only?: boolean;
  contact?: { licensing?: string };
  spec?: string;
}
export interface Validation { valid: boolean; errors: string[]; warnings: string[] }

/** Largest file read by fetchTerms, in bytes. */
export const MAX_BYTES = 100_000;
export const FREE_MAX_REQUESTS = 1_000_000_000;
/** Longest `paths[].match` pattern, and most `*`s in one, that resolve will try (longer ones never match). */
export const GLOB_MAX_LEN = 512;
export const GLOB_MAX_STARS = 16;

const ACCESS = ["allow", "paid", "deny"] as const;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/* ---------- Reading ---------- */

/** The terms in a fetched text, or null when it isn't an AI Terms file. */
export function parse(text: string): AiTerms | null {
  try {
    const t = JSON.parse(text) as AiTerms;
    return isObj(t) && typeof t.ai_terms === "string" && isObj(t.uses) ? t : null;
  } catch { return null; }
}

/** The ai-terms URL in a Link header value, or null. */
export function termsLink(link: string | null | undefined): string | null {
  const m = /<([^>]+)>\s*;\s*rel="?ai-terms"?/i.exec(link ?? "");
  return m ? m[1]! : null;
}

/**
 * Reads a site's terms from https://<host>/.well-known/ai-terms. Null when there are none or they can't be read.
 * Only https; redirects are not followed; at most MAX_BYTES are read.
 */
export async function fetchTerms(site: string, opts: { timeoutMs?: number; userAgent?: string; purpose?: Use; fetch?: typeof fetch } = {}): Promise<AiTerms | null> {
  let host: string;
  try {
    const u = new URL(site.includes("://") ? site : `https://${site}`);
    if (u.protocol !== "https:" || !u.host) return null;
    host = u.host;
  } catch { return null; }
  const f = opts.fetch ?? fetch;
  try {
    const res = await f(`https://${host}/.well-known/ai-terms`, {
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      headers: { "user-agent": opts.userAgent ?? "ai-terms-js/0.1", accept: "application/json", "ai-purpose": opts.purpose ?? "agent" },
    });
    if (res.status !== 200 || !res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    await reader.cancel().catch(() => {});
    const bytes = new Uint8Array(Math.min(size, MAX_BYTES));
    let at = 0;
    for (const c of chunks) { const part = c.subarray(0, bytes.length - at); bytes.set(part, at); at += part.length; if (at >= bytes.length) break; }
    return parse(new TextDecoder().decode(bytes));
  } catch { return null; }
}

/* ---------- Paths ---------- */

/** One path segment against one pattern segment (no "/" in either): `*` matches any run of characters. */
function segmentMatch(pat: string, seg: string): boolean {
  const pieces = pat.split("*");
  if (pieces.length === 1) return pat === seg;
  const first = pieces[0]!, last = pieces[pieces.length - 1]!;
  if (first.length + last.length > seg.length || !seg.startsWith(first) || !seg.endsWith(last)) return false;
  let at = first.length;
  const end = seg.length - last.length;
  for (let k = 1; k < pieces.length - 1; k++) {
    const piece = pieces[k]!;
    if (!piece) continue;
    const found = seg.indexOf(piece, at);
    if (found < 0 || found + piece.length > end) return false;
    at = found + piece.length;
  }
  return true;
}

/** `paths[].match` glob: literal characters, and `*` matching within one path segment (never "/"). Linear time. */
export function globMatch(pattern: string, path: string): boolean {
  if (pattern.length > GLOB_MAX_LEN) return false;
  let stars = 0;
  for (const c of pattern) if (c === "*" && ++stars > GLOB_MAX_STARS) return false;
  const ps = pattern.split("/"), ss = path.split("/");
  if (ps.length !== ss.length) return false;
  return ps.every((p, k) => segmentMatch(p, ss[k]!));
}

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
/** A path or pattern in one comparable form (RFC 3986 section 6.2.2): "/café", "/caf%c3%a9" and "/caf%C3%A9" are one path. */
export function normalizePath(s: string): string {
  return s.replace(/%([0-9A-Fa-f]{2})|[^A-Za-z0-9\-._~!$&'()*+,;=:@/]/gu, (m, hex: string | undefined) => {
    if (hex) { const c = String.fromCharCode(parseInt(hex, 16)); return UNRESERVED.test(c) ? c : "%" + hex.toUpperCase(); }
    return Array.from(new TextEncoder().encode(m), (b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join("");
  });
}

const usable = (t: unknown): t is UseTerms => isObj(t) && (ACCESS as readonly unknown[]).includes(t.access);

/**
 * The terms that apply to one use on one path. Each use on its own: among the `paths` entries that match the path and
 * list the use, the one with the most literal characters (the first on a tie); else the top-level terms for the use;
 * else `default`. A path is compared without its query.
 */
export function resolve(terms: Pick<AiTerms, "uses" | "default" | "paths">, use: Use, path = "/"): UseTerms {
  let best: { len: number; t: UseTerms } | null = null;
  const p0 = normalizePath(path.split("?")[0]!);
  for (const p of Array.isArray(terms.paths) ? terms.paths : []) {
    const t = p?.uses?.[use];
    if (!usable(t) || typeof p.match !== "string") continue;
    const m = normalizePath(p.match);
    const len = m.replace(/\*/g, "").length;
    if (globMatch(m, p0) && (!best || len > best.len)) best = { len, t };
  }
  const top = isObj(terms.uses) ? terms.uses[use] : undefined;
  return best?.t ?? (usable(top) ? top : { access: (ACCESS as readonly unknown[]).includes(terms.default) ? terms.default : "allow" });
}

/** The free allowance on a paid or denied use, or null. Only verified clients get it; attribution still applies. */
export function freeAllowance(rule: UseTerms | undefined): FreeAllowance | null {
  const f = rule?.free;
  if (!rule || rule.access === "allow" || !isObj(f) || typeof f.requests !== "number" || !Number.isInteger(f.requests) || f.requests < 1 || f.requests > FREE_MAX_REQUESTS || (f.per !== "hour" && f.per !== "day")) return null;
  return { requests: f.requests, per: f.per };
}

/** True when a client may proceed: access is allow, or paid at or under the client's cap. Clients must cap what they pay. */
export function allowedWithin(rule: UseTerms, maxPriceUsd: number): boolean {
  if (rule.access === "allow") return true;
  if (rule.access !== "paid") return false;
  const amount = Number(rule.price?.amount);
  return typeof rule.price?.amount === "string" && /^\d+(\.\d+)?$/.test(rule.price.amount) && Number.isFinite(amount) && amount <= maxPriceUsd;
}

/* ---------- AI Preferences (IETF aipref) ---------- */

export type Pref = "y" | "n";
export type Prefs = Partial<Record<"train-ai" | "ai-use" | "search", Pref>>;
const CATEGORIES = ["train-ai", "ai-use", "search"] as const;

/**
 * The aipref preferences the terms imply for one path: training → train-ai (y only if allowed); answer and agent →
 * ai-use (stated only when they agree); search → search=y only when search and training are both allowed (aipref
 * Search also allows training inside search). A priced use is n. A report_only file states nothing.
 */
export function prefsFor(terms: Pick<AiTerms, "uses" | "default" | "paths"> & { report_only?: boolean }, path = "/"): Prefs {
  if (terms.report_only === true) return {};
  const a = (u: Use) => resolve(terms, u, path).access;
  const out: Prefs = { "train-ai": a("training") === "allow" ? "y" : "n" };
  const answer = a("answer") === "allow", agent = a("agent") === "allow";
  if (answer && agent) out["ai-use"] = "y";
  else if (!answer && !agent) out["ai-use"] = "n";
  if (a("search") === "allow" && a("training") === "allow") out.search = "y";
  return out;
}

/** The Content-Usage header value the terms imply for a path ("" when nothing can be stated), e.g. "train-ai=n, ai-use=y". */
export function contentUsage(terms: Pick<AiTerms, "uses" | "default" | "paths"> & { report_only?: boolean }, path = "/"): string {
  const p = prefsFor(terms, path);
  return CATEGORIES.filter((c) => p[c]).map((c) => `${c}=${p[c]}`).join(", ");
}

/* ---------- Validation ---------- */

/** payment.endpoint: an absolute https URL with no spaces, quotes, angle brackets, query or fragment. */
export function isEndpointUrl(v: string): boolean {
  if (!/^https:\/\/[^\s<>"?#]+$/.test(v)) return false;
  try { return new URL(v).protocol === "https:"; } catch { return false; }
}

/** Checks a parsed document against AI Terms 0.1. Errors break a client; warnings are things a careful site would fix. */
export function validate(doc: unknown, opts: { origin?: string } = {}): Validation {
  const errors: string[] = [], warnings: string[] = [];
  if (!isObj(doc)) return { valid: false, errors: ["The file must be a JSON object."], warnings };
  if (typeof doc.ai_terms !== "string") errors.push('"ai_terms" is required: the spec version, "0.1".');
  else if (doc.ai_terms !== VERSION) warnings.push(`"ai_terms" is "${doc.ai_terms}"; this validator knows ${VERSION}.`);
  let site: URL | null = null;
  if (typeof doc.site !== "string") errors.push('"site" is required: the origin the terms apply to, like "https://example.com".');
  else { try { site = new URL(doc.site); } catch { errors.push('"site" must be a full URL, like "https://example.com".'); } }
  if (site && site.protocol !== "https:" && site.protocol !== "http:") { errors.push('"site" must be a web origin, like "https://example.com".'); site = null; }
  if (site && site.protocol !== "https:") warnings.push('"site" should be an https:// origin.');
  if (site && (site.pathname !== "/" || site.search || site.hash)) warnings.push(`"site" should be an origin with no path, like "${site.origin}".`);
  if (site && opts.origin) {
    try {
      const from = new URL(opts.origin);
      if (from.host.replace(/^www\./, "") !== site.host.replace(/^www\./, "")) warnings.push(`"site" is ${site.origin} but the file was served from ${from.origin}.`);
    } catch { /* not a URL: skip the comparison */ }
  }
  if (typeof doc.updated !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(doc.updated) || Number.isNaN(Date.parse(doc.updated)) || new Date(`${doc.updated}T00:00:00Z`).toISOString().slice(0, 10) !== doc.updated) errors.push('"updated" is required: the date of the last change, as YYYY-MM-DD.');
  if (!(ACCESS as readonly unknown[]).includes(doc.default)) errors.push('"default" is required: "allow", "paid" or "deny" for a client that declares no use.');

  const checkUse = (v: unknown, where: string): boolean => {
    if (!isObj(v)) { errors.push(`${where} must be an object with "access".`); return false; }
    if (!(ACCESS as readonly unknown[]).includes(v.access)) { errors.push(`${where}.access must be "allow", "paid" or "deny".`); return false; }
    if (v.attribution !== undefined && !["required", "requested", "none"].includes(v.attribution as string)) errors.push(`${where}.attribution must be "required", "requested" or "none".`);
    if (v.free !== undefined) {
      const f = v.free;
      if (!isObj(f)) errors.push(`${where}.free must be an object: { "requests": 100, "per": "day" }.`);
      else {
        if (typeof f.requests !== "number" || !Number.isInteger(f.requests) || f.requests < 1 || f.requests > FREE_MAX_REQUESTS) errors.push(`${where}.free.requests must be a whole number from 1 to 1,000,000,000.`);
        if (f.per !== "hour" && f.per !== "day") errors.push(`${where}.free.per must be "hour" or "day".`);
        for (const k of Object.keys(f)) if (k !== "requests" && k !== "per") warnings.push(`${where}.free.${k} is not part of 0.1; clients ignore it.`);
        if (v.access === "allow") warnings.push(`${where} has a "free" allowance but its access is already "allow"; the allowance is ignored.`);
      }
    }
    if (v.access !== "paid") {
      if (v.price !== undefined) warnings.push(`${where} has a "price" but its access is "${String(v.access)}"; the price is ignored.`);
      return false;
    }
    const p = v.price;
    if (!isObj(p)) { errors.push(`${where} is "paid" but has no "price".`); return true; }
    if (typeof p.amount !== "string" || !/^\d+(\.\d+)?$/.test(p.amount)) errors.push(`${where}.price.amount must be a decimal string, like "0.002".`);
    else if (Number(p.amount) <= 0) errors.push(`${where}.price.amount must be more than 0; use "access": "allow" for free.`);
    else if (Number(p.amount) > 1) warnings.push(`${where}.price.amount is $${p.amount}; careful clients cap what they pay, so a high price may mean no reads.`);
    if (p.currency !== "USD") errors.push(`${where}.price.currency must be "USD" in 0.1.`);
    if (p.per !== "page" && p.per !== "request") errors.push(`${where}.price.per must be "page" or "request".`);
    return true;
  };
  const checkPayment = (p: unknown, where: string) => {
    if (!isObj(p)) { errors.push(`${where} must be an object.`); return; }
    if (p.protocol !== "x402") errors.push(`${where}.protocol must be "x402" in 0.1.`);
    if (typeof p.endpoint !== "string" || !p.endpoint) errors.push(`${where}.endpoint is required: where a client pays.`);
    else if (!isEndpointUrl(p.endpoint)) errors.push(`${where}.endpoint must be an https URL with no query or fragment: the content at path P is paid for at endpoint + P.`);
  };

  let topPaid = doc.default === "paid", unpayablePath = false, anyPaid = topPaid;
  if (!isObj(doc.uses)) errors.push('"uses" is required: terms for search, answer, training and agent.');
  else {
    for (const u of USES) {
      if (doc.uses[u] === undefined) errors.push(`"uses.${u}" is missing; all four uses are required.`);
      else if (checkUse(doc.uses[u], `uses.${u}`)) topPaid = anyPaid = true;
    }
    for (const k of Object.keys(doc.uses)) if (!(USES as readonly string[]).includes(k)) warnings.push(`"uses.${k}" is not one of the four uses; clients ignore it.`);
  }
  if (doc.paths !== undefined) {
    if (!Array.isArray(doc.paths)) errors.push('"paths" must be a list.');
    else doc.paths.forEach((p: unknown, i: number) => {
      const where = `paths[${i}]`;
      if (!isObj(p)) { errors.push(`${where} must be an object with "match" and "uses".`); return; }
      if (typeof p.match !== "string" || !p.match.startsWith("/")) errors.push(`${where}.match must be a path that starts with "/".`);
      let paid = false;
      if (!isObj(p.uses) || !Object.keys(p.uses).length) errors.push(`${where}.uses must list at least one use.`);
      else for (const [k, v] of Object.entries(p.uses)) {
        if (!(USES as readonly string[]).includes(k)) warnings.push(`${where}.uses.${k} is not one of the four uses; clients ignore it.`);
        else if (checkUse(v, `${where}.uses.${k}`)) paid = true;
      }
      if (p.payment !== undefined) checkPayment(p.payment, `${where}.payment`);
      else if (paid) unpayablePath = true;
      if (paid) anyPaid = true;
    });
  }
  if (doc.payment !== undefined) checkPayment(doc.payment, "payment");
  else if (topPaid || unpayablePath) errors.push('A use is "paid" but there is no "payment": a client has no way to pay.');
  if (doc.purpose_header !== undefined && doc.purpose_header !== "AI-Purpose") errors.push('"purpose_header" must be "AI-Purpose" in 0.1.');
  if (doc.preview !== undefined) {
    if (!isObj(doc.preview)) errors.push('"preview" must be an object: { "shows": ["title", "description", "words"], "delivery": "must-match" }.');
    else {
      if (!["must-match", "per-quote", "not-checked"].includes(doc.preview.delivery as string)) errors.push('"preview.delivery" must be "must-match", "per-quote" or "not-checked".');
      if (doc.preview.shows !== undefined && (!Array.isArray(doc.preview.shows) || doc.preview.shows.some((v: unknown) => !["title", "description", "excerpt", "words"].includes(v as string)))) errors.push('"preview.shows" must list "title", "description", "excerpt" and/or "words".');
      if (!anyPaid) warnings.push('"preview" is set but no use is "paid"; it only matters for paid pages.');
    }
  }
  if (doc.report_only === true && anyPaid) warnings.push('"report_only" is true but a use is "paid"; pick one.');
  if (doc.contact !== undefined && !isObj(doc.contact)) errors.push('"contact" must be an object.');
  if (doc.identity !== undefined) {
    if (!isObj(doc.identity)) errors.push('"identity" must be an object: { "verify": ["published-ip-ranges"] }.');
    else {
      if (doc.identity.verify !== undefined && (!Array.isArray(doc.identity.verify) || doc.identity.verify.some((v: unknown) => typeof v !== "string"))) errors.push('"identity.verify" must be a list of method names, like ["published-ip-ranges"].');
      if (doc.identity.unverified !== undefined && doc.identity.unverified !== "treated-as-claimed" && doc.identity.unverified !== "treated-as-unidentified") warnings.push('"identity.unverified" is not "treated-as-claimed" or "treated-as-unidentified"; clients treat it as "treated-as-unidentified".');
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}
