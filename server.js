import http from "node:http";

function cors(allowedOrigin) {
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "X-Internal-Token, Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  };
}

export async function handle({ method, url, headers, body }, deps) {
  const ch = cors(deps.config.allowedOrigin);
  if (method === "OPTIONS") return { status: 204, headers: ch, body: null };

  if (method === "GET" && url === "/info") {
    return { status: 200, headers: ch, body: { available: await deps.getAvailable() } };
  }

  if (method === "POST" && url === "/send") {
    if (deps.config.internalToken) {
      const provided = headers["x-internal-token"] ?? headers["X-Internal-Token"];
      if (provided !== deps.config.internalToken) {
        return { status: 401, headers: ch, body: "Unauthorized" };
      }
    }
    const address = String(body?.address ?? "").replace(/^"|"$/g, "").trim();
    const sats = Number(body?.sats);
    try {
      const txid = await deps.dispense({ wallet: deps.wallet, address, sats, maxSend: deps.config.maxSend });
      return { status: 200, headers: ch, body: { txid } };
    } catch (e) {
      return { status: 400, headers: ch, body: e?.message ?? "send failed" };
    }
  }

  return { status: 404, headers: ch, body: "Not found" };
}

export function startServer(deps) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = null;
    if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = null; } }
    const out = await handle({ method: req.method, url: req.url, headers: req.headers, body }, deps);
    const isJson = out.body !== null && typeof out.body === "object";
    res.writeHead(out.status, { ...out.headers, "Content-Type": isJson ? "application/json" : "text/plain" });
    res.end(out.body === null ? "" : isJson ? JSON.stringify(out.body) : String(out.body));
  });
  server.listen(deps.config.port, () => console.log(`arkade-faucet-daemon listening on :${deps.config.port}`));
  return server;
}
