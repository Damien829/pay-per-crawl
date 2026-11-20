// Writes spec/web-bot-auth-vectors.json: signed requests every Web Bot Auth verifier must agree on (the AIPayGen gateway's
// verifier and its site integrations). Deterministic: a fixed TEST-ONLY seed (never a real key) and fixed times,
// and Ed25519 signatures are deterministic, so rerunning gives the same file. Run from the repo root:
//   node spec/gen-web-bot-auth-vectors.mjs
import { writeFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const SEED = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"; // TEST ONLY
const OTHER_SEED = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100"; // TEST ONLY: a key not in the directory
const pkcs8 = (hex) => Buffer.from("302e020100300506032b657004220420" + hex, "hex");
const b64u = (b) => Buffer.from(b).toString("base64url");
const NOW = 1_795_000_000; // seconds; 2026-11-18T07:06:40Z
const HOST = "signer.example", SITE = "https://site.example/blog/post";

async function key(seed) {
  const priv = await crypto.subtle.importKey("pkcs8", pkcs8(seed), { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", priv);
  const pub = { kty: "OKP", crv: "Ed25519", x: jwk.x };
  const kid = b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`{"crv":"Ed25519","kty":"OKP","x":"${pub.x}"}`)));
  return { priv, pub, kid };
}
/** RFC 9421 base for the covered components, as src/webbotauth.ts builds it. */
function base(url, headers, comps, raw) {
  const u = new URL(url);
  const lines = comps.map((c) => `"${c}": ${c === "@authority" ? u.host.toLowerCase() : headers[c]}`);
  lines.push(`"@signature-params": ${raw}`);
  return lines.join("\n");
}
async function signed(k, o = {}) {
  const comps = ["@authority", "signature-agent"];
  const created = o.created ?? NOW - 10, expires = o.expires ?? NOW + 50;
  const raw = `(${comps.map((c) => `"${c}"`).join(" ")});created=${created};expires=${expires};keyid="${o.kid ?? k.kid}";alg="ed25519";tag="web-bot-auth"`;
  const headers = { "signature-agent": `"https://${HOST}"`, "signature-input": `sig1=${raw}` };
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, k.priv, new TextEncoder().encode(base(o.signedUrl ?? SITE, headers, comps, raw))));
  if (o.tamper) sig[0] ^= 1;
  headers.signature = `sig1=:${Buffer.from(sig).toString("base64")}:`;
  return { url: SITE, method: "GET", headers };
}

const k = await key(SEED), other = await key(OTHER_SEED);
const directory = { host: HOST, keys: [k.pub] };
const cases = [
  ["good", await signed(k), "verified", "verified"],
  ["signed for another site (wrong @authority)", await signed(k, { signedUrl: "https://other.example/blog/post" }), "invalid:bad signature", "invalid:bad signature"],
  ["signature bytes changed", await signed(k, { tamper: true }), "invalid:bad signature", "invalid:bad signature"],
  ["signed by a key that isn't in the directory", await signed(other), "invalid:unknown key", "unchecked"],
  ["expired more than 300 s ago", await signed(k, { created: NOW - 400, expires: NOW - 301 }), "invalid:expired", "invalid:expired"],
  ["expired exactly 300 s ago (inside the skew)", await signed(k, { created: NOW - 400, expires: NOW - 300 }), "verified", "verified"],
  ["created more than 300 s ahead", await signed(k, { created: NOW + 301, expires: NOW + 400 }), "invalid:not yet valid", "invalid:not yet valid"],
  ["created exactly 300 s ahead (inside the skew)", await signed(k, { created: NOW + 300, expires: NOW + 400 }), "verified", "verified"],
  ["expires not after created", await signed(k, { created: NOW - 10, expires: NOW - 10 }), "invalid:expired", "invalid:expired"],
];
const out = {
  about: "Web Bot Auth test vectors (draft-ietf-webbotauth-httpsig-protocol). Each request was signed by a TEST-ONLY key; `now` is the verifier's clock in seconds. `gateway` is what the AIPayGen gateway answers with the directory given. `snippet` is what a site snippet answers with the same keys as its hourly key map (https://aipaygen.com/v1/signed_agents): a key it doesn't know may be newer than its map, so it is unchecked (fall back to IP rules), never fake.",
  now: NOW,
  max_skew_s: 300,
  directory,
  cases: cases.map(([name, request, gateway, snippet]) => ({ name, request, gateway, snippet })),
};
writeFileSync(new URL("./web-bot-auth-vectors.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(`${cases.length} cases, kid ${k.kid}`);
