// Pay-per-crawl via AIPayGen. Put AIPAYGEN_SECRET (the gateway_secret) in your environment.
const GATEWAY = "https://aipaygen.com/g/YOUR_ROUTE_ID";
const AI_BOTS = /GPTBot|OAI\-SearchBot|ChatGPT\-User|ClaudeBot|Claude\-User|Claude\-SearchBot|anthropic\-ai|PerplexityBot|Perplexity\-User|Google\-Extended|GoogleOther|CCBot|Bytespider|Amazonbot|Applebot\-Extended|meta\-externalagent|FacebookBot|cohere\-ai|Diffbot|YouBot|MistralAI\-User|DuckAssistBot|PetalBot|Timpibot|ImagesiftBot|omgili|AI2Bot/i;
app.use(async (req, res, next) => {
  if (process.env.AIPAYGEN_SECRET && req.get("x-aipaygen-gateway-secret") === process.env.AIPAYGEN_SECRET) return next();
  const paying = req.get("payment-signature") || req.get("x-payment");
  if (!AI_BOTS.test(req.get("user-agent") || "") && !paying) return next();
  const headers = { ...req.headers }; delete headers.host;
  const r = await fetch(GATEWAY + req.originalUrl, { method: "GET", headers });
  r.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding"].includes(k)) res.set(k, v); });
  res.status(r.status).send(Buffer.from(await r.arrayBuffer()));
});
