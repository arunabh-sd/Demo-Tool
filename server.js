const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const LOGS_FILE = path.join(__dirname, "logs.json");
const ALLOWED_DOMAINS = ["blitzscale.co", "shopdeck.com"];
const ADMIN_EMAILS = ["arunabh.mishra@blitzscale.co"];

function readLogs() {
  try { if (fs.existsSync(LOGS_FILE)) return JSON.parse(fs.readFileSync(LOGS_FILE, "utf8")); } catch(e) {}
  return { sessions: [], clicks: [] };
}
function writeLogs(data) { try { fs.writeFileSync(LOGS_FILE, JSON.stringify(data)); } catch(e) {} }
function appendLog(type, entry) {
  const logs = readLogs();
  if (!logs[type]) logs[type] = [];
  logs[type].push({ ...entry, ts: new Date().toISOString() });
  if (logs[type].length > 10000) logs[type] = logs[type].slice(-10000);
  writeLogs(logs);
}

function verifyGoogleToken(idToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "oauth2.googleapis.com",
      path: "/tokeninfo?id_token=" + encodeURIComponent(idToken),
      method: "GET"
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { const p = JSON.parse(data); p.error ? reject(new Error(p.error)) : resolve(p); } catch(e) { reject(e); }});
    });
    req.on("error", reject);
    req.end();
  });
}

function readBody(req) {
  return new Promise(resolve => { let b = ""; req.on("data", c => b += c); req.on("end", () => resolve(b)); });
}

const MIME = { ".html":"text/html;charset=utf-8", ".js":"application/javascript", ".css":"text/css", ".json":"application/json", ".ico":"image/x-icon" };
function cors(res) { res.setHeader("Access-Control-Allow-Origin","*"); res.setHeader("Access-Control-Allow-Methods","POST,GET,OPTIONS"); res.setHeader("Access-Control-Allow-Headers","Content-Type"); }
function json(res, code, data) { res.writeHead(code, {"Content-Type":"application/json"}); cors(res); res.end(JSON.stringify(data)); }

async function handleAuth(req, res) {
  const body = await readBody(req);
  let idToken = "";
  try { idToken = JSON.parse(body).idToken || ""; } catch(e) {}
  if (!idToken) return json(res, 400, {ok:false, error:"No token"});
  try {
    const p = await verifyGoogleToken(idToken);
    const email = p.email || "";
    const domain = email.split("@")[1];
    const allowed = ALLOWED_DOMAINS.includes(domain);
    const isAdmin = ADMIN_EMAILS.includes(email);
    if (allowed) appendLog("sessions", {email, name: p.name||"", action:"login"});
    json(res, 200, {ok:allowed, email, name:p.name||"", isAdmin, error: allowed?null:"Domain not allowed. Only blitzscale.co and shopdeck.com accounts permitted."});
  } catch(e) { json(res, 401, {ok:false, error:"Invalid Google token"}); }
}

async function handleLog(req, res) {
  const body = await readBody(req);
  let entry = {};
  try { entry = JSON.parse(body); } catch(e) {}
  if (entry.email && entry.action) appendLog("clicks", {email:entry.email, action:entry.action, tab:entry.tab||"", detail:entry.detail||""});
  json(res, 200, {ok:true});
}

async function handleGetLogs(req, res) {
  const q = url.parse(req.url, true).query;
  if (!q.email || !ADMIN_EMAILS.includes(q.email)) return json(res, 403, {error:"Unauthorized"});
  const logs = readLogs();
  const logType = q.type === "sessions" ? "sessions" : "clicks";
  let entries = logs[logType] || [];
  if (q.from) entries = entries.filter(e => e.ts >= q.from);
  if (q.to) entries = entries.filter(e => e.ts <= q.to + "T23:59:59.999Z");
  const byEmail = {};
  entries.forEach(e => {
    if (!byEmail[e.email]) byEmail[e.email] = {count:0, lastSeen:""};
    byEmail[e.email].count++;
    if (e.ts > byEmail[e.email].lastSeen) byEmail[e.email].lastSeen = e.ts;
  });
  json(res, 200, {total:entries.length, byEmail, entries:entries.slice(-500)});
}

async function handleGenerate(req, res) {
  const body = await readBody(req);
  let prompt = "";
  try { prompt = JSON.parse(body).prompt || ""; } catch(e) {}
  if (!prompt) return json(res, 400, {error:"No prompt"});
  if (!ANTHROPIC_API_KEY) return json(res, 500, {error:"API key not configured"});
  const payload = JSON.stringify({model:"claude-haiku-4-5-20251001", max_tokens:200, messages:[{role:"user",content:prompt}]});
  const apiReq = https.request({
    hostname:"api.anthropic.com", path:"/v1/messages", method:"POST",
    headers:{"Content-Type":"application/json","x-api-key":ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01","Content-Length":Buffer.byteLength(payload)}
  }, apiRes => {
    let data = "";
    apiRes.on("data", c => data += c);
    apiRes.on("end", () => {
      try {
        const parsed = JSON.parse(data);
        const text = (parsed.content||[]).find(b=>b.type==="text")?.text||"{}";
        json(res, 200, {text});
      } catch(e) { json(res, 500, {error:"Parse error"}); }
    });
  });
  apiReq.on("error", e => json(res, 500, {error:e.message}));
  apiReq.write(payload); apiReq.end();
}

function serveStatic(req, res) {
  let fp = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  fp = path.join(__dirname, fp);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, {"Content-Type": MIME[path.extname(fp)] || "text/plain"});
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204); cors(res); return res.end(); }
  const p = url.parse(req.url).pathname;
  if (req.method === "POST" && p === "/api/auth") return handleAuth(req, res);
  if (req.method === "POST" && p === "/api/log") return handleLog(req, res);
  if (req.method === "GET" && p === "/api/logs") return handleGetLogs(req, res);
  if (req.method === "POST" && p === "/api/generate") return handleGenerate(req, res);
  serveStatic(req, res);
}).listen(PORT, () => {
  console.log("ShopDeck Demo on port " + PORT);
  console.log("Anthropic key: " + (ANTHROPIC_API_KEY?"SET":"MISSING"));
  console.log("Google Client ID: " + (GOOGLE_CLIENT_ID?"SET":"MISSING"));
});
