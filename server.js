import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import http from "http";
import { initSchema, query } from "./db.js";

import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const PORT = process.env.PORT || 3000;

const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || "")
  .split(",").map(s => s.trim()).filter(Boolean).map(s => s.toLowerCase());

function isAdmin(username) {
  return ADMIN_USERNAMES.includes(String(username || "").toLowerCase());
}

function nowPlusMinutes(min) {
  return new Date(Date.now() + min * 60 * 1000);
}

function randCode(len = 8) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const LOCATIONS = [
  "South of Simiran",
  "West of Hintenfau",
  "North of White View",
  "West of Ottenhal",
  "South West of Espenhal",
  "North of Tolenque",
  "South of Hintenfau",
  "South of Ottenhal"
];

function pickLocation() {
  return LOCATIONS[Math.floor(Math.random() * LOCATIONS.length)];
}

// Auth helpers
function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "30d" });
}

async function getUserById(id) {
  const r = await query("SELECT id, username, username_lc, team_name, rating, banned, password_hash FROM users WHERE id=$1", [id]);
  return r.rows[0] || null;
}

async function getUserByUsernameCI(username) {
  const lc = String(username || "").trim().toLowerCase();
  if (!lc) return null;
  const r = await query("SELECT id, username, username_lc, team_name, rating, banned, password_hash FROM users WHERE username_lc=$1", [lc]);
  return r.rows[0] || null;
}

async function authMiddleware(req, res, next) {
  try {
    const token = req.cookies?.token || req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Not authenticated" });
    const payload = jwt.verify(token, JWT_SECRET);
    req.auth = payload;
    return next();
  } catch {
    return res.status(401).json({ error: "Not authenticated" });
  }
}

async function adminMiddleware(req, res, next) {
  const u = await getUserById(req.auth.id);
  if (!u) return res.status(401).json({ error: "Not authenticated" });
  if (!isAdmin(u.username)) return res.status(403).json({ error: "Admin only" });
  req.adminUser = u;
  return next();
}

async function notifyUser(userId, type, payload) {
  const r = await query(
    "INSERT INTO notifications(user_id,type,payload) VALUES ($1,$2,$3) RETURNING id, user_id, type, payload, created_at, is_read",
    [userId, type, JSON.stringify(payload || {})]
  );
  io.to(`user:${userId}`).emit("notification", r.rows[0]);
}

async function archiveFight(code, result, ratingDelta) {
  // Copy from fights -> match_history if not exists
  const f = await query("SELECT * FROM fights WHERE code=$1", [code]);
  if (!f.rows[0]) return;
  const fight = f.rows[0];
  const ex = await query("SELECT 1 FROM match_history WHERE code=$1", [code]);
  if (ex.rows.length) return;

  await query(
    `INSERT INTO match_history(code, team_size, format, created_at, accepted_at, concluded_at, location, poster_ids, accepter_ids, poster_team_name, accepter_team_name, result, final_status, rating_delta)
      VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (code) DO NOTHING`,
      [f.code, f.team_size, f.format, f.created_at, f.accepted_at, fight.location, f.poster_ids, f.accepter_ids, f.poster_team_name, f.accepter_team_name, winner, (winner==="DRAW"?"DRAW":"CONCLUDED"), delta]
    );

    // Notify all participants
    const participants = Array.from(new Set([...(fight.poster_ids||[]),...(fight.accepter_ids||[])]));
    for(const uid of participants){
      io.to(`user:${uid}`).emit("matchConcluded", { code, winner, delta });
    }
    io.to(`match:${code}`).emit("winnerUpdate", { concluded:true, winner });
    return res.json({ ok:true, concluded:true, winner });
  }

  io.to(`match:${code}`).emit("winnerUpdate", { poster_confirm: pc, accepter_confirm: ac });
  res.json({ ok:true });
});


app.post("/api/fights/:code/extend", authMiddleware, async (req,res)=>{
  const code=String(req.params.code);
  const r = await query("SELECT * FROM fights WHERE code=$1", [code]);
  const fight = r.rows[0];
  if(!fight) return res.status(404).json({ error:"not found" });
  if(fight.status!=="MATCHED") return res.status(400).json({ error:"match not active" });

  const meId=req.auth.id;
  const isPoster = (fight.poster_ids||[]).includes(meId);
  const isAccepter = (fight.accepter_ids||[]).includes(meId);
  if(!isPoster && !isAccepter) return res.status(403).json({ error:"Not a participant" });

  // cap 2 extensions (15m each)
  const extCount = fight.extension_count || 0;
  if(extCount >= 2){
    return res.json({ ok:false, capped:true, match_ends_at: fight.match_expires_at });
  }

  const col = isPoster ? "poster_extend" : "accepter_extend";
  await query(`UPDATE fights SET ${col}=TRUE WHERE code=$1`, [code]);

  const r2 = await query("SELECT poster_extend, accepter_extend, extension_count, match_expires_at FROM fights WHERE code=$1", [code]);
  const pe=r2.rows[0].poster_extend;
  const ae=r2.rows[0].accepter_extend;
  const cnt=r2.rows[0].extension_count||0;

  if(pe && ae){
    // apply extension
    const newEnd = new Date((fight.match_expires_at ? Date.parse(fight.match_expires_at) : Date.now()) + 15*60*1000);
    await query("UPDATE fights SET match_expires_at=$1, extension_count=extension_count+1, poster_extend=FALSE, accepter_extend=FALSE WHERE code=$2", [newEnd.toISOString(), code]);
    io.to(`match:${code}`).emit("extended", { match_ends_at: newEnd.toISOString() });
    return res.json({ ok:true, match_ends_at: newEnd.toISOString() });
  }
  res.json({ ok:true, waiting:true });
});


app.post("/api/admin/reports/clear", authMiddleware, adminMiddleware, async (_req,res)=>{
  await query("TRUNCATE reports");
  res.json({ ok:true });
});


app.get("/api/admin/players", authMiddleware, adminMiddleware, async (_req,res)=>{
  const r = await query(`
    SELECT u.username, u.rating, COALESCE(m.cnt,0)::int AS matches
    FROM users u
    LEFT JOIN (
      SELECT uid, COUNT(*) AS cnt
      FROM (
        SELECT unnest(poster_ids || accepter_ids) AS uid FROM match_history
      ) x
      GROUP BY uid
    ) m ON m.uid = u.id
    WHERE u.banned=false
    ORDER BY u.rating DESC, u.username ASC
    LIMIT 500
  `);
  res.json({ players: r.rows });
});


app.post("/api/admin/matches/clear", authMiddleware, adminMiddleware, async (_req,res)=>{
  // Remove all current fights and history + chat logs
  await query("TRUNCATE match_messages");
  await query("TRUNCATE fights CASCADE");
  await query("TRUNCATE match_history CASCADE");
  res.json({ ok:true });
});

// Admin endpoints
app.get("/api/admin/me", authMiddleware, async (req, res) => {
  const u = await getUserById(req.auth.id);
  if (!u) return res.status(401).json({ error: "Not authenticated" });
  if (!isAdmin(u.username)) return res.status(403).json({ error: "Admin only" });
  res.json({ ok: true, username: u.username });
});

app.get("/api/admin/fights", authMiddleware, adminMiddleware, async (_req,res)=>{
  const activeR = await query("SELECT * FROM fights ORDER BY created_at DESC");
  const histR = await query("SELECT * FROM match_history ORDER BY concluded_at DESC NULLS LAST, created_at DESC");

  const allRows = [...(activeR.rows||[]), ...(histR.rows||[])];
  const allIds = Array.from(new Set(allRows.flatMap(r=>[...(r.poster_ids||[]), ...(r.accepter_ids||[])])));
  const nameMap = new Map();
  if(allIds.length){
    const u = await query("SELECT id, username FROM users WHERE id = ANY($1)", [allIds]);
    for(const row of u.rows) nameMap.set(row.id, row.username);
  }

  const enrich = (r, archived=false)=>{
    const poster_usernames = (r.poster_ids||[]).map(id=>nameMap.get(id)).filter(Boolean);
    const accepter_usernames = (r.accepter_ids||[]).map(id=>nameMap.get(id)).filter(Boolean);
    const delta = Number(r.rating_delta||0);
    let winner_usernames = [];
    let loser_usernames = [];
    let result = null;

    if(archived){
      const team = r.result || null;
      if(team==="POSTER"){ winner_usernames = poster_usernames; loser_usernames = accepter_usernames; result="POSTER"; }
      else if(team==="ACCEPTER"){ winner_usernames = accepter_usernames; loser_usernames = poster_usernames; result="ACCEPTER"; }
      else if(team==="DRAW" || String(r.final_status||"").toUpperCase()==="DRAW"){ result="DRAW"; }
    }

    return {
      code: r.code,
      status: r.status || (archived?"ARCHIVED":""),
      team_size: r.team_size,
      format: r.format,
      created_at: r.created_at,
      accepted_at: r.accepted_at,
      concluded_at: r.concluded_at,
      location: r.location,
      rating_delta: delta,
      poster_usernames,
      accepter_usernames,
      result,
      winner_usernames,
      loser_usernames
    };
  };

  res.json({
    active: (activeR.rows||[]).map(r=>enrich(r,false)),
    history: (histR.rows||[]).map(r=>enrich(r,true))
  });
});

app.get("/api/admin/reports", authMiddleware, adminMiddleware, async (_req,res)=>{
  const r = await query("SELECT id, username, message, created_at FROM reports ORDER BY created_at DESC LIMIT 200");
  res.json({ reports: r.rows });
});


app.post("/api/admin/reset-rating", authMiddleware, adminMiddleware, async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const rating = Number(req.body?.rating);
  if (!username || !Number.isFinite(rating)) return res.status(400).json({ error: "username and numeric rating required" });
  const u = await getUserByUsernameCI(username);
  if (!u) return res.status(404).json({ error: "user not found" });
  await query("UPDATE users SET rating=$1 WHERE id=$2", [rating, u.id]);
  res.json({ ok: true });
});

app.post("/api/admin/reset-all-ratings", authMiddleware, adminMiddleware, async (req, res) => {
  const rating = Number(req.body?.rating);
  const r = Number.isFinite(rating) ? rating : 1000;
  await query("UPDATE users SET rating=$1 WHERE banned=false", [r]);
  res.json({ ok: true, rating: r });
});

app.post("/api/admin/delete-fight", authMiddleware, adminMiddleware, async (req, res) => {
  const code = String(req.body?.code || "").trim();
  if (!code) return res.status(400).json({ error: "code required" });
  await query("DELETE FROM fights WHERE code=$1", [code]);
  res.json({ ok: true });
});

app.post("/api/admin/wipe-notifications", authMiddleware, adminMiddleware, async (_req, res) => {
  await query("DELETE FROM notifications");
  io.emit("adminWipedNotifications", { at: new Date().toISOString() });
  res.json({ ok: true });
});

app.post("/api/admin/ban-user", authMiddleware, adminMiddleware, async (req, res) => {
  const username = String(req.body?.username || "").trim();
  if (!username) return res.status(400).json({ error: "username required" });
  const u = await getUserByUsernameCI(username);
  if (!u) return res.status(404).json({ error: "user not found" });
  await query("UPDATE users SET banned=true WHERE id=$1", [u.id]);
  res.json({ ok: true });
});

app.post("/api/admin/delete-user", authMiddleware, adminMiddleware, async (req, res) => {
  const username = String(req.body?.username || "").trim();
  if (!username) return res.status(400).json({ error: "username required" });
  const u = await getUserByUsernameCI(username);
  if (!u) return res.status(404).json({ error: "user not found" });
  if (u.id === req.adminUser.id) return res.status(400).json({ error: "Cannot delete your own account." });
  await query("DELETE FROM users WHERE id=$1", [u.id]);
  res.json({ ok: true });
});

// Cleanup: expire open fights every minute
setInterval(async () => {
  try {
    const now = new Date();
    const exp = await query("SELECT code, poster_ids FROM fights WHERE status='OPEN' AND expires_at <= NOW()");
    for (const f of exp.rows) {
      await query("DELETE FROM fights WHERE code=$1", [f.code]);
      for (const uid of f.poster_ids || []) {
        await notifyUser(uid, "FIGHT_EXPIRED", { code: f.code });
      }
    }

    const matchExp = await query("SELECT code, poster_ids, accepter_ids FROM fights WHERE status='MATCHED' AND match_expires_at <= NOW()");
    for (const f of matchExp.rows) {
      // Draw
      await query("UPDATE fights SET status='CONCLUDED', result='DRAW', rating_delta=0 WHERE code=$1", [f.code]);
      await archiveFight(f.code, "DRAW", 0);
      await query("DELETE FROM fights WHERE code=$1", [f.code]);

      const all = [...(f.poster_ids || []), ...(f.accepter_ids || [])];
      for (const uid of all) await notifyUser(uid, "FIGHT_CONCLUDED", { code: f.code, result: "DRAW", ratingDelta: 0 });
      io.to(`match:${f.code}`).emit("matchConcluded", { winner: "DRAW", delta: 0 });
    }
  } catch (e) {
    // ignore
  }
}, 60_000);

// Socket rooms

function parseCookies(cookieHeader){
  const out = {};
  if(!cookieHeader) return out;
  const parts = cookieHeader.split(";");
  for(const p of parts){
    const i = p.indexOf("=");
    if(i===-1) continue;
    const k = p.slice(0,i).trim();
    const v = p.slice(i+1).trim();
    out[k]=decodeURIComponent(v);
  }
  return out;
}

io.use((socket, next) => {
  try{
    const cookies = parseCookies(socket.request.headers.cookie || "");
    const token = cookies.token;
    if(token){
      const payload = jwt.verify(token, JWT_SECRET);
      socket.data.userId = payload.id;
      socket.data.username = payload.username;
      socket.join(`user:${payload.id}`);
    }
  }catch{}
  next();
});

io.on("connection", (socket) => {
  socket.on("auth", async (token) => {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      socket.data.userId = payload.id;
      socket.data.username = payload.username;
      socket.join(`user:${payload.id}`);
      socket.emit("authed", { ok: true });
    } catch {
      socket.emit("authed", { ok: false });
    }
  });

  socket.on("joinFightRoom", async ({ code }) => {
    const c = String(code||"").trim();
    if(!c) return;
    socket.join(`match:${c}`);
    socket.data.currentMatchCode = c;
    socket.emit("joined", { code: c });
  });

  socket.on("joinMatch", async (code) => {
    const c = (typeof code==="object" && code) ? String(code.code||"") : String(code||"");
    code = c.trim();
    const userId = socket.data.userId;
    if (!userId) return;
    // allow if participant or admin
    const fr = await query("SELECT * FROM fights WHERE code=$1", [code]);
    let fight = fr.rows[0];
    if (!fight) {
      const hr = await query("SELECT * FROM match_history WHERE code=$1", [code]);
      if (hr.rows[0]) fight = { ...hr.rows[0], status: "ARCHIVED" };
    }
    if (!fight) return;

    const u = await getUserById(userId);
    const allowed = await isUserInFight(userId, fight) || (u && isAdmin(u.username));
    if (!allowed) return;

    socket.join(`match:${code}`);
    socket.data.currentMatchCode = code;
  });

  socket.on("chat", async ({ text }) => {
    const userId = socket.data.userId;
    if(!userId) return;
    const code = socket.data.currentMatchCode;
    if(!code) return;
    const fr = await query("SELECT * FROM fights WHERE code=$1", [code]);
    let fight = fr.rows[0] || null;
    if(!fight){
      const hr = await query("SELECT * FROM match_history WHERE code=$1", [code]);
      if(hr.rows[0]) fight = { ...hr.rows[0], status:"ARCHIVED" };
    }
    if(!fight) return;
    const me = await getUserById(userId);
    const allowed = await isUserInFight(userId, fight) || (me && isAdmin(me.username));
    if(!allowed) return;

    // lock chat if concluded
    if((fight.status === "CONCLUDED") || (fight.status === "ARCHIVED") ) return;

    const clean = String(text||"").trim().slice(0, 280);
    if(!clean) return;

    const side = (fight.poster_ids||[]).includes(userId) ? "POSTER" : ((fight.accepter_ids||[]).includes(userId) ? "ACCEPTER" : "SYSTEM");

    const ALIASES = ["Akathar","Guardian","Fire Dragon","Dark Dragon","Devil","Demon Lord","Goblin Fighter","Goblin Warlord","Goblin Scout","Brown Bear","Tomb Iklit","Human Guildmaster","Deadeye","Manscorpion","Gorra Dar","Sand Iklit","Erodach","Baradron","Forest Golem","Troll","Troll Lord","Great White","Brownie","Goblin Shaman","Giant Spider","Windlord","Centaur","Ancient","Beastman","Crog","Khamset","Minotaur","Kraken"];
    const h = crypto.createHash("sha1").update(code+":"+userId).digest("hex");
    const idx = parseInt(h.slice(0,8),16) % ALIASES.length;
    const alias = ALIASES[idx];

    await query("INSERT INTO match_messages(code, side, alias, text) VALUES ($1,$2,$3,$4)", [code, side, alias, clean]);
    const payload = { side, alias, text: clean, at: new Date().toISOString() };
    io.to(`match:${code}`).emit("chat", payload);
  });
});

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is not set. Set it to your Render Postgres Internal URL.");
    process.exit(1);
  }
  await initSchema();

  server.listen(PORT, () => {
    console.log(`Server listening on ${PORT}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
