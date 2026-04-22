const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "943701391495-qae2ifdl3hqrni4s6kgqe6c1j19qc914.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const BASE_URL = process.env.BASE_URL || "http://localhost:" + PORT;
const LOGS_FILE = path.join(__dirname, "logs.json");
const SESSIONS_FILE = path.join(__dirname, "sessions.json");
const ALLOWED_DOMAINS = ["blitzscale.co", "shopdeck.com"];
const ADMIN_EMAILS = ["arunabh.mishra@blitzscale.co"];

function readSessions() {
  try { if (fs.existsSync(SESSIONS_FILE)) return JSON.parse(fs.readFileSync(SESSIONS_FILE,"utf8")); } catch(e) {}
  return {};
}
function writeSessions(s) { try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(s)); } catch(e) {} }
function createSession(email, name) {
  const token = crypto.randomBytes(32).toString("hex");
  const sessions = readSessions();
  sessions[token] = { email, name, isAdmin: ADMIN_EMAILS.includes(email), created: Date.now() };
  writeSessions(sessions);
  return token;
}
function getSession(req) {
  const match = (req.headers.cookie||"").match(/sd_session=([a-f0-9]+)/);
  if (!match) return null;
  const sessions = readSessions();
  const s = sessions[match[1]];
  if (!s) return null;
  if (Date.now() - s.created > 8*60*60*1000) { delete sessions[match[1]]; writeSessions(sessions); return null; }
  return s;
}

function readLogs() {
  try { if (fs.existsSync(LOGS_FILE)) return JSON.parse(fs.readFileSync(LOGS_FILE,"utf8")); } catch(e) {}
  return { sessions:[], clicks:[] };
}
function writeLogs(d) { try { fs.writeFileSync(LOGS_FILE, JSON.stringify(d)); } catch(e) {} }
function appendLog(type, entry) {
  const logs = readLogs();
  if (!logs[type]) logs[type]=[];
  logs[type].push({...entry, ts: new Date().toISOString()});
  if (logs[type].length>10000) logs[type]=logs[type].slice(-10000);
  writeLogs(logs);
}

function readBody(req) {
  return new Promise(resolve => { let b=""; req.on("data",c=>b+=c); req.on("end",()=>resolve(b)); });
}
function send(res, code, data, headers) {
  if (res.headersSent) return;
  const isHtml = typeof data === "string" && (data.startsWith("<!") || data.startsWith("<html"));
  res.writeHead(code, Object.assign({"Content-Type": isHtml ? "text/html;charset=utf-8" : "application/json"}, headers||{}));
  res.end(typeof data === "string" ? data : JSON.stringify(data));
}
function redirect(res, loc) {
  if (res.headersSent) return;
  res.writeHead(302, {Location:loc}); res.end();
}
function httpsGet(u) {
  return new Promise((resolve,reject) => {
    https.get(u, r => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>resolve(d)); }).on("error",reject);
  });
}
function httpsPost(hostname, p, body) {
  return new Promise((resolve,reject) => {
    const payload = new url.URLSearchParams(body).toString();
    const req = https.request({hostname, path:p, method:"POST",
      headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(payload)}
    }, r => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>resolve(d)); });
    req.on("error",reject); req.write(payload); req.end();
  });
}

function loginPage(error) {
  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new url.URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: BASE_URL+"/auth/callback",
    response_type: "code",
    scope: "openid email profile",
    prompt: "select_account"
  }).toString();
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ShopDeck Demo</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:linear-gradient(135deg,#0f172a,#1e3a8a);min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:'Inter',sans-serif}.card{background:#fff;border-radius:16px;padding:48px 40px;max-width:420px;width:90%;text-align:center;box-shadow:0 25px 60px rgba(0,0,0,.4)}.logo{width:52px;height:52px;background:#2563eb;border-radius:12px;display:flex;align-items:center;justify-content:center;margin:0 auto 20px}h1{font-size:24px;font-weight:800;color:#0f172a;margin-bottom:8px}.sub{font-size:14px;color:#64748b;margin-bottom:32px}.gbtn{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;padding:13px 20px;background:#fff;border:1.5px solid #e2e8f0;border-radius:10px;font-size:15px;font-weight:600;color:#0f172a;cursor:pointer;text-decoration:none;transition:all .15s}.gbtn:hover{background:#f8fafc;border-color:#cbd5e1;box-shadow:0 2px 8px rgba(0,0,0,.08)}.err{margin-top:14px;padding:10px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:13px;color:#dc2626}.note{margin-top:20px;font-size:11px;color:#94a3b8}</style>
</head><body><div class="card">
<div class="logo"><svg width="28" height="28" viewBox="0 0 28 28" fill="none"><rect x="4" y="4" width="13" height="13" rx="3" stroke="white" stroke-width="2.2" fill="none"/><rect x="11" y="11" width="13" height="13" rx="3" stroke="rgba(255,255,255,.55)" stroke-width="1.8" fill="none"/></svg></div>
<h1>ShopDeck Demo</h1><p class="sub">Sign in with your work Google account</p>
<a class="gbtn" href="${authUrl}">
<svg width="20" height="20" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20H24v8h11.3C33.6 33.6 29.3 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 6 1.1 8.2 3l5.7-5.7C34.3 5.1 29.4 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21c10.9 0 20-7.9 20-21 0-1.4-.1-2.7-.4-4z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.5 16 19 13 24 13c3.1 0 6 1.1 8.2 3l5.7-5.7C34.3 5.1 29.4 3 24 3c-7.7 0-14.4 4.4-17.7 11.7z"/><path fill="#4CAF50" d="M24 45c5.2 0 10-1.9 13.7-5l-6.3-5.2C29.5 36.6 26.8 37.5 24 37.5c-5.2 0-9.7-3.5-11.3-8.3l-6.5 5C9.8 40.7 16.4 45 24 45z"/><path fill="#1565C0" d="M43.6 20H24v8h11.3c-.8 2.3-2.3 4.3-4.2 5.7l6.3 5.2C41.1 35.5 44 30.1 44 24c0-1.4-.1-2.7-.4-4z"/></svg>
Continue with Google</a>
${error ? `<div class="err">${decodeURIComponent(error)}</div>` : ""}
<p class="note">Only blitzscale.co and shopdeck.com accounts permitted</p>
</div></body></html>`;
}

async function handleCallback(req, res) {
  const q = url.parse(req.url, true).query;
  if (q.error) return redirect(res, "/login?error=Access+denied+by+Google");
  if (!q.code) return redirect(res, "/login?error=No+auth+code");
  try {
    const tokenData = JSON.parse(await httpsPost("oauth2.googleapis.com", "/token", {
      code: q.code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: BASE_URL+"/auth/callback", grant_type: "authorization_code"
    }));
    if (!tokenData.access_token) return redirect(res, "/login?error=Token+exchange+failed.+Check+GOOGLE_CLIENT_SECRET");
    const user = JSON.parse(await httpsGet("https://www.googleapis.com/oauth2/v3/userinfo?access_token="+tokenData.access_token));
    const email = user.email||"";
    const domain = email.split("@")[1];
    if (!ALLOWED_DOMAINS.includes(domain)) return redirect(res, "/login?error=Access+denied.+Only+blitzscale.co+and+shopdeck.com+accounts.");
    const token = createSession(email, user.name||email);
    appendLog("sessions", {email, name:user.name||"", action:"login"});
    res.writeHead(302, {Location:"/", "Set-Cookie":`sd_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`});
    res.end();
  } catch(e) {
    console.error("OAuth error:", e.message);
    redirect(res, "/login?error=Auth+failed.+Try+again.");
  }
}

async function handleMe(req, res) {
  const s = getSession(req);
  if (!s) return send(res, 401, {email:null});
  send(res, 200, {email:s.email, name:s.name, isAdmin:s.isAdmin});
}

async function handleLog(req, res) {
  const body = await readBody(req);
  let entry={};
  try{entry=JSON.parse(body);}catch(e){}
  const s = getSession(req);
  const email = s?s.email:(entry.email||"unknown");
  if (email&&entry.action) appendLog("clicks",{email,action:entry.action,tab:entry.tab||"",detail:entry.detail||""});
  send(res,200,{ok:true});
}

async function handleGetLogs(req, res) {
  const s = getSession(req);
  if (!s||!ADMIN_EMAILS.includes(s.email)) return send(res,403,{error:"Unauthorized"});
  const q = url.parse(req.url,true).query;
  const logs = readLogs();
  const logType = q.type==="sessions"?"sessions":"clicks";
  let entries = logs[logType]||[];
  if (q.from) entries=entries.filter(e=>e.ts>=q.from);
  if (q.to) entries=entries.filter(e=>e.ts<=q.to+"T23:59:59.999Z");
  const byEmail={};
  entries.forEach(e=>{
    if(!byEmail[e.email])byEmail[e.email]={count:0,lastSeen:""};
    byEmail[e.email].count++;
    if(e.ts>byEmail[e.email].lastSeen)byEmail[e.email].lastSeen=e.ts;
  });
  send(res,200,{total:entries.length,byEmail,entries:entries.slice(-500)});
}

async function handleGenerate(req, res) {
  const s = getSession(req);
  if (!s) return send(res,401,{error:"Not authenticated"});
  const body = await readBody(req);
  let prompt="";
  try{prompt=JSON.parse(body).prompt||"";}catch(e){}
  if(!prompt) return send(res,400,{error:"No prompt"});
  if(!ANTHROPIC_API_KEY) return send(res,500,{error:"API key not configured"});
  const payload=JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:200,messages:[{role:"user",content:prompt}]});
  const apiReq=https.request({hostname:"api.anthropic.com",path:"/v1/messages",method:"POST",
    headers:{"Content-Type":"application/json","x-api-key":ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01","Content-Length":Buffer.byteLength(payload)}
  },apiRes=>{
    let data=""; apiRes.on("data",c=>data+=c);
    apiRes.on("end",()=>{
      try{const p=JSON.parse(data);send(res,200,{text:(p.content||[]).find(b=>b.type==="text")?.text||"{}"});}
      catch(e){send(res,500,{error:"Parse error"});}
    });
  });
  apiReq.on("error",e=>send(res,500,{error:e.message}));
  apiReq.write(payload); apiReq.end();
}

function serveStatic(req, res) {
  const s = getSession(req);
  const pathname = url.parse(req.url).pathname;
  if (!s && pathname!=="/" && !pathname.startsWith("/auth/") && pathname!=="/login") {
    return redirect(res, "/login");
  }
  let fp = pathname==="/"?"/index.html":pathname;
  fp = path.join(__dirname, path.normalize(fp).replace(/^(\.\.(\/|\\|$))+/,""));
  fs.readFile(fp, (err, data) => {
    if (err) { if(!res.headersSent){res.writeHead(404);res.end("Not found");} return; }
    const MIME={".html":"text/html;charset=utf-8",".js":"application/javascript",".css":"text/css",".json":"application/json",".ico":"image/x-icon",".png":"image/png",".jpg":"image/jpeg"};
    if(!res.headersSent){res.writeHead(200,{"Content-Type":MIME[path.extname(fp)]||"text/plain"});res.end(data);}
  });
}

http.createServer(async (req,res)=>{
  const pathname = url.parse(req.url).pathname;
  if(req.method==="OPTIONS"){res.writeHead(204);res.end();return;}
  try{
    if(pathname==="/login") return send(res,200,loginPage(url.parse(req.url,true).query.error));
    if(pathname==="/auth/callback") return await handleCallback(req,res);
    if(pathname==="/logout"){
      const m=(req.headers.cookie||"").match(/sd_session=([a-f0-9]+)/);
      if(m){const s=readSessions();delete s[m[1]];writeSessions(s);}
      res.writeHead(302,{Location:"/login","Set-Cookie":"sd_session=; Path=/; Max-Age=0"});
      return res.end();
    }
    if(pathname==="/api/me") return await handleMe(req,res);
    if(req.method==="POST"&&pathname==="/api/log") return await handleLog(req,res);
    if(req.method==="GET"&&pathname==="/api/logs") return await handleGetLogs(req,res);
    if(req.method==="POST"&&pathname==="/api/generate") return await handleGenerate(req,res);
    serveStatic(req,res);
  }catch(e){
    console.error("Error:",e.message);
    if(!res.headersSent){res.writeHead(500);res.end("Server error");}
  }
}).listen(PORT,()=>{
  console.log("ShopDeck Demo on port "+PORT);
  console.log("Base URL: "+BASE_URL);
  console.log("Google Client ID: "+(GOOGLE_CLIENT_ID?"SET":"MISSING"));
  console.log("Google Client Secret: "+(GOOGLE_CLIENT_SECRET?"SET":"MISSING"));
});
