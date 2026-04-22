const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const LOGS_FILE = path.join(__dirname, "logs.json");
const ALLOWED_DOMAINS = ["blitzscale.co", "shopdeck.com"];
const ADMIN_EMAILS = ["arunabh.mishra@blitzscale.co"];

// ── Logs ─────────────────────────────────────────────────────────────────────
function readLogs() {
  try { if (fs.existsSync(LOGS_FILE)) return JSON.parse(fs.readFileSync(LOGS_FILE, "utf8")); } catch(e) {}
  return { sessions: [], clicks: [] };
}
function writeLogs(data) {
  try { fs.writeFileSync(LOGS_FILE, JSON.stringify(data)); } catch(e) { console.error("writeLogs error:", e.message); }
}
function appendLog(type, entry) {
  const logs = readLogs();
  if (!logs[type]) logs[type] = [];
  logs[type].push({ ...entry, ts: new Date().toISOString() });
  if (logs[type].length > 10000) logs[type] = logs[type].slice(-10000);
  writeLogs(logs);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise(resolve => {
    let b = "";
    req.on("data", c => { b += c; });
    req.on("end", () => resolve(b));
  });
}

// Single safe response sender — never double-sends
function send(res, code, data) {
  if (res.headersSent) return;
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(typeof data === "string" ? data : JSON.stringify(data));
}

const MIME = { ".html":"text/html;charset=utf-8", ".js":"application/javascript", ".css":"text/css", ".json":"application/json", ".ico":"image/x-icon" };

// ── Handlers ──────────────────────────────────────────────────────────────────
async function handleAuth(req, res) {
  try {
    const body = await readBody(req);
    let idToken = "";
    try { idToken = JSON.parse(body).idToken || ""; } catch(e) {}
    if (!idToken) return send(res, 400, { ok: false, error: "No token" });

    // Log the session (trust client-side domain check, just record)
    let email = "";
    try {
      const payload = JSON.parse(Buffer.from(idToken.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"), "base64").toString());
      email = payload.email || "";
      const domain = email.split("@")[1];
      if (ALLOWED_DOMAINS.includes(domain)) {
        appendLog("sessions", { email, name: payload.name || "", action: "login" });
      }
      send(res, 200, { ok: true, email });
    } catch(e) {
      send(res, 200, { ok: true }); // don't fail, client already validated
    }
  } catch(e) {
    send(res, 500, { error: e.message });
  }
}

async function handleLog(req, res) {
  try {
    const body = await readBody(req);
    let entry = {};
    try { entry = JSON.parse(body); } catch(e) {}
    if (entry.email && entry.action) {
      appendLog("clicks", { email: entry.email, action: entry.action, tab: entry.tab || "", detail: entry.detail || "" });
    }
    send(res, 200, { ok: true });
  } catch(e) {
    send(res, 500, { error: e.message });
  }
}

async function handleGetLogs(req, res) {
  try {
    const q = url.parse(req.url, true).query;
    if (!q.email || !ADMIN_EMAILS.includes(q.email)) return send(res, 403, { error: "Unauthorized" });
    const logs = readLogs();
    const logType = q.type === "sessions" ? "sessions" : "clicks";
    let entries = logs[logType] || [];
    if (q.from) entries = entries.filter(e => e.ts >= q.from);
    if (q.to) entries = entries.filter(e => e.ts <= q.to + "T23:59:59.999Z");
    const byEmail = {};
    entries.forEach(e => {
      if (!byEmail[e.email]) byEmail[e.email] = { count: 0, lastSeen: "" };
      byEmail[e.email].count++;
      if (e.ts > byEmail[e.email].lastSeen) byEmail[e.email].lastSeen = e.ts;
    });
    send(res, 200, { total: entries.length, byEmail, entries: entries.slice(-500) });
  } catch(e) {
    send(res, 500, { error: e.message });
  }
}

async function handleGenerate(req, res) {
  try {
    const body = await readBody(req);
    let prompt = "";
    try { prompt = JSON.parse(body).prompt || ""; } catch(e) {}
    if (!prompt) return send(res, 400, { error: "No prompt" });
    if (!ANTHROPIC_API_KEY) return send(res, 500, { error: "API key not configured" });

    const payload = JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 200, messages: [{ role: "user", content: prompt }] });
    const apiReq = https.request({
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Length": Buffer.byteLength(payload) }
    }, apiRes => {
      let data = "";
      apiRes.on("data", c => { data += c; });
      apiRes.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text = (parsed.content || []).find(b => b.type === "text")?.text || "{}";
          send(res, 200, { text });
        } catch(e) { send(res, 500, { error: "Parse error" }); }
      });
    });
    apiReq.on("error", e => send(res, 500, { error: e.message }));
    apiReq.write(payload);
    apiReq.end();
  } catch(e) {
    send(res, 500, { error: e.message });
  }
}

function serveStatic(req, res) {
  let fp = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  // Prevent directory traversal
  fp = path.normalize(fp).replace(/^(\.\.(\/|\\|$))+/, "");
  fp = path.join(__dirname, fp);
  fs.readFile(fp, (err, data) => {
    if (err) { if (!res.headersSent) { res.writeHead(404); res.end("Not found"); } return; }
    if (res.headersSent) return;
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "text/plain" });
    res.end(data);
  });
}

// ── Server ────────────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    if (!res.headersSent) {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST,GET,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
      res.end();
    }
    return;
  }

  const pathname = url.parse(req.url).pathname;

  try {
    if (req.method === "POST" && pathname === "/api/auth")     return await handleAuth(req, res);
    if (req.method === "POST" && pathname === "/api/log")      return await handleLog(req, res);
    if (req.method === "GET"  && pathname === "/api/logs")     return await handleGetLogs(req, res);
    if (req.method === "POST" && pathname === "/api/generate") return await handleGenerate(req, res);
    serveStatic(req, res);
  } catch(e) {
    console.error("Unhandled error:", e.message);
    send(res, 500, { error: "Internal server error" });
  }
}).listen(PORT, () => {
  console.log("ShopDeck Demo on port " + PORT);
  console.log("Anthropic key: " + (ANTHROPIC_API_KEY ? "SET" : "MISSING"));
  console.log("Logs file: " + LOGS_FILE);
});
