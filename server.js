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

// Disable caching so deploys show immediately
app.use((req,res,next)=>{
  if(req.path.startsWith("/public") || req.path.endsWith(".js") || req.path.endsWith(".css") || req.path.endsWith(".html") || req.path.startsWith("/audio")){
    res.setHeader("Cache-Control","no-store, max-age=0");
  }
  next();
});
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
  const r = await query("SELECT id, username, username_lc, team_name, rating, wins, losses, banned, password_hash FROM users WHERE id=$1", [id]);
  return r.rows[0] || null;
}

async function getUserByUsernameCI(username) {
  const lc = String(username || "").trim().toLowerCase();
  if (!lc) return null;
  const r = await query("SELECT id, username, username_lc, team_name, rating, wins, losses, banned, password_hash FROM users WHERE username_lc=$1", [lc]);
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
    `INSERT INTO match_history(code, team_size, format, created_at, accepted_at, concluded_at, location, poster_ids, accepter_ids, poster_team_name, accepter_team_name, result, rating_delta)
     VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,$8,$9,$10,$11,$12)`,
    [
      fight.code,
      fight.team_size,
      fight.format,
      fight.created_at,
      fight.accepted_at,
      fight.location,
      fight.poster_ids,
      fight.accepter_ids || [],
      fight.poster_team_name,
      fight.accepter_team_name,
      result,
      ratingDelta
    ]
  );
}

// Static
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req,res)=>res.sendFile(path.join(__dirname, "public", "index.html")));
app.use("/audio", express.static(path.join(__dirname, "audio")));

// Pages
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/match/:code", (_req, res) => res.sendFile(path.join(__dirname, "public", "match.html")));

// Auth: "Login or Register" (create if doesn't exist)
app.post("/api/auth", async (req, res) => {
  const uname = String(req.body?.username || "").trim();
  const pw = String(req.body?.password || "");
  if (!uname || uname.length < 2) return res.status(400).json({ error: "username required" });
  if (!pw || pw.length < 3) return res.status(400).json({ error: "password required" });

  const lc = uname.toLowerCase();
  const existing = await getUserByUsernameCI(uname);

  if (!existing) {
    const hash = bcrypt.hashSync(pw, 10);
    const created = await query(
      "INSERT INTO users(username, username_lc, password_hash, team_name, rating, banned) VALUES ($1,$2,$3,$4,1000,false) RETURNING id, username, team_name, rating, banned",
      [uname, lc, hash, `Team of ${uname}`]
    );
    const user = created.rows[0];
    const token = signToken(user);
    res.cookie("token", token, { httpOnly: true, sameSite: "lax" });
    return res.json({ ok: true, user });
  }

  if (existing.banned) return res.status(403).json({ error: "This account is banned." });

  const ok = bcrypt.compareSync(pw, existing.password_hash);
  if (!ok) return res.status(401).json({ error: "wrong password" });

  const token = signToken(existing);
  res.cookie("token", token, { httpOnly: true, sameSite: "lax" });
  return res.json({ ok: true, user: { id: existing.id, username: existing.username, team_name: existing.team_name, rating: existing.rating, banned: existing.banned } });
});

app.post("/api/logout", (_req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

app.get("/api/me", authMiddleware, async (req, res) => {
  const u = await getUserById(req.auth.id);
  if (!u || u.banned) return res.json({ authenticated: false });
  const rankQ = await query("SELECT COUNT(*)::int + 1 AS user_rank FROM users WHERE COALESCE(rating,0) > $1", [u.rating || 0]);
  res.json({
    authenticated: true,
    user: {
      id: u.id,
      username: u.username,
      team_name: u.team_name,
      rating: u.rating,
      wins: u.wins || 0,
      losses: u.losses || 0,
      rank: rankQ.rows[0]?.user_rank || 1
    }
  });
});

app.post("/api/team-name", authMiddleware, async (req, res) => {
  const name = String(req.body?.team_name || "").trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: "team name required" });
  await query("UPDATE users SET team_name=$1 WHERE id=$2", [name, req.auth.id]);
  res.json({ ok: true });
});

// compatibility alias
app.post("/api/me/team-name", authMiddleware, async (req,res)=>{
  req.url="/api/team-name";
  return app._router.handle(req,res,()=>{});
});

// Leaderboard
app.get("/api/leaderboard", async (_req, res) => {
  const r = await query("SELECT username, rating FROM users WHERE banned=false AND rating >= 50 ORDER BY rating DESC LIMIT 25");
  res.json({ users: r.rows });
});

// Announcements
app.get("/api/announcements", async (_req, res) => {
  const r = await query("SELECT id, text, by_username AS by, created_at FROM announcements ORDER BY created_at DESC LIMIT 10");
  res.json({ items: r.rows });
});

app.post("/api/announcements", authMiddleware, adminMiddleware, async (req, res) => {
  const text = String(req.body?.text || "").trim().slice(0, 400);
  if (!text) return res.status(400).json({ error: "text required" });
  const r = await query(
    "INSERT INTO announcements(text, by_username) VALUES ($1,$2) RETURNING id, text, by_username AS by, created_at",
    [text, req.adminUser.username]
  );
  io.emit("announcement", r.rows[0]);
  res.json({ ok: true, ann: r.rows[0] });
});

app.post("/api/admin/clear-announcements", authMiddleware, adminMiddleware, async (_req, res) => {
  await query("DELETE FROM announcements");
  io.emit("announcementCleared", { at: new Date().toISOString() });
  res.json({ ok: true });
});

// Notifications paging
app.get("/api/notifications", authMiddleware, async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(25, Math.max(5, Number(req.query.pageSize || 5)));

  const totalR = await query("SELECT COUNT(*)::int AS c FROM notifications WHERE user_id=$1", [req.auth.id]);
  const total = totalR.rows[0]?.c || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const offset = (page - 1) * pageSize;

  const r = await query(
    "SELECT id, user_id, type, payload, created_at, is_read FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
    [req.auth.id, pageSize, offset]
  );
  const active = await query(
    "SELECT code, team_size, format, location, match_expires_at, created_at, accepted_at FROM fights WHERE status='MATCHED' AND ($1=ANY(poster_ids) OR $1=ANY(accepter_ids)) ORDER BY accepted_at DESC NULLS LAST, created_at DESC LIMIT 1",
    [req.auth.id]
  );
  let notifications = r.rows;
  if(active.rows[0]){
    const a = active.rows[0];
    notifications = [{
      id: `current-${a.code}`,
      user_id: req.auth.id,
      type: "CURRENT_MATCH",
      payload: { code: a.code, team_size: a.team_size, meetup_location: a.location || "", accepted_at: a.accepted_at || a.created_at },
      created_at: a.accepted_at || a.created_at,
      is_read: false
    }, ...notifications];
  }
  res.json({ notifications, page, pageSize, totalPages, total: total + (active.rows[0] ? 1 : 0) });
});

app.post("/api/notifications/:id/read", authMiddleware, async (req, res) => {
  const id = Number(req.params.id);
  await query("UPDATE notifications SET is_read=true WHERE id=$1 AND user_id=$2", [id, req.auth.id]);
  res.json({ ok: true });
});

// Fight helpers
async function isUserInFight(userId, fight) {
  return (fight.poster_ids || []).includes(userId) || (fight.accepter_ids || []).includes(userId);
}

async function userHasActiveFight(userId) {
  const r = await query("SELECT 1 FROM fights WHERE status='OPEN' AND ($1=ANY(poster_ids) OR $1=ANY(COALESCE(accepter_ids, ARRAY[]::int[]))) LIMIT 1", [userId]);
  return r.rows.length > 0;
}


// compatibility endpoints used by older UI
app.get("/api/fights/open", authMiddleware, async (req,res)=>{
  const r = await query("SELECT code, team_size, format, expires_at, poster_ids, match_mode FROM fights WHERE status='OPEN' ORDER BY created_at DESC");
  const fights = r.rows || [];
  const allIds = Array.from(new Set(fights.flatMap(f=>f.poster_ids||[])));
  const nameMap = new Map();
  if(allIds.length){
    const u = await query("SELECT id, username FROM users WHERE id = ANY($1)", [allIds]);
    for(const row of u.rows) nameMap.set(row.id, row.username);
  }
  const meId = req.auth.id;
  const out = fights.map(f=>{
    const posterIds = f.poster_ids || [];
    const is_participant = posterIds.includes(meId);
    const is_mine = posterIds.length ? posterIds[0] === meId : false;
    const creator_names = posterIds.map(id=>nameMap.get(id)).filter(Boolean);
    return {
      code: f.code,
      team_size: f.team_size,
      format: f.format,
      open_expires_at: f.expires_at,
      is_participant,
      is_mine,
      creator_names,
      match_mode: f.match_mode || 'LAWLESS'
    };
  });
  res.json({ fights: out });
});

app.get("/api/fights/mine-open", authMiddleware, async (req,res)=>{
  const meId = req.auth.id;
  const r = await query("SELECT code, team_size, format FROM fights WHERE status='OPEN' AND $1 = ANY(poster_ids) ORDER BY created_at DESC LIMIT 1", [meId]);
  if(!r.rows.length) return res.json({ has_open:false });
  res.json({ has_open:true, fight: r.rows[0] });
});

app.post("/api/fights/create", authMiddleware, async (req,res)=>{
  // forward to the main create fight handler by calling the same logic block below.
  // This route duplicates the logic in POST /api/fights to keep compatibility.
  const u = await getUserById(req.auth.id);
  if (!u || u.banned) return res.status(403).json({ error: "banned" });

  if (await userHasActiveFight(u.id)) return res.status(400).json({ error: "You already have an active fight." });

  const teamSize = Number(req.body?.teamSize || 1);
  const matchMode = String(req.body?.match_mode || "LAWLESS").toUpperCase()==="LAWFUL" ? "LAWFUL" : "LAWLESS";
  if (!Number.isFinite(teamSize) || teamSize < 1 || teamSize > 99) return res.status(400).json({ error: "invalid team size" });

  const teammateUsernames = Array.isArray(req.body?.teammateUsernames) ? req.body.teammateUsernames : [];
  if (teamSize > 1 && teammateUsernames.length !== (teamSize - 1)) {
    return res.status(400).json({ error: `For ${teamSize}v${teamSize}, provide exactly ${teamSize - 1} teammate usernames (excluding you).` });
  }

  const ids = [u.id];
  const seen = new Set([u.username_lc]);
  for (const name of teammateUsernames) {
    const uu = await getUserByUsernameCI(name);
    if (!uu) return res.status(400).json({ error: `Unknown user: ${name}` });
    if (uu.banned) return res.status(400).json({ error: `User is banned: ${uu.username}` });
    if (seen.has(uu.username_lc)) return res.status(400).json({ error: "Duplicate teammate username" });
    seen.add(uu.username_lc);
    if (uu.id === u.id) return res.status(400).json({ error: "Do not list yourself as teammate" });
    if (await userHasActiveFight(uu.id)) return res.status(400).json({ error: `${uu.username} is already participating in a fight.` });
    ids.push(uu.id);
  }

  const code = randCode(8);
  const format = `${teamSize}v${teamSize}`;
  const expiresAt = nowPlusMinutes(30);

  await query(
    "INSERT INTO fights(code, team_size, format, status, created_at, expires_at, poster_ids, poster_team_name, match_mode) VALUES ($1,$2,$3,'OPEN',NOW(),$4,$5,$6,$7)",
    [code, teamSize, format, expiresAt, ids, u.team_name, matchMode]
  );

  res.json({ ok: true, code });
});

// List open fights
app.get("/api/fights", authMiddleware, async (req, res) => {
  const r = await query("SELECT code, team_size, format, created_at, expires_at, poster_ids, accepter_ids, status FROM fights WHERE status='OPEN' ORDER BY created_at DESC");
  res.json({ fights: r.rows });
});

// Create fight: teammateUsernames excludes self
app.post("/api/fights", authMiddleware, async (req, res) => {
  const u = await getUserById(req.auth.id);
  if (!u || u.banned) return res.status(403).json({ error: "banned" });

  if (await userHasActiveFight(u.id)) return res.status(400).json({ error: "You already have an active fight." });

  const teamSize = Number(req.body?.teamSize || 1);
  const matchMode = String(req.body?.match_mode || "LAWLESS").toUpperCase()==="LAWFUL" ? "LAWFUL" : "LAWLESS";
  if (!Number.isFinite(teamSize) || teamSize < 1 || teamSize > 99) return res.status(400).json({ error: "invalid team size" });

  const teammateUsernames = Array.isArray(req.body?.teammateUsernames) ? req.body.teammateUsernames : [];
  if (teamSize > 1 && teammateUsernames.length !== (teamSize - 1)) {
    return res.status(400).json({ error: `For ${teamSize}v${teamSize}, provide exactly ${teamSize - 1} teammate usernames (excluding you).` });
  }

  // build poster_ids
  const ids = [u.id];
  const seen = new Set([u.username_lc]);
  for (const name of teammateUsernames) {
    const uu = await getUserByUsernameCI(name);
    if (!uu) return res.status(400).json({ error: `Unknown user: ${name}` });
    if (uu.banned) return res.status(400).json({ error: `User is banned: ${uu.username}` });
    if (seen.has(uu.username_lc)) return res.status(400).json({ error: "Duplicate teammate username" });
    seen.add(uu.username_lc);
    if (uu.id === u.id) return res.status(400).json({ error: "Do not list yourself as teammate" });
    if (await userHasActiveFight(uu.id)) return res.status(400).json({ error: `${uu.username} is already participating in a fight.` });
    ids.push(uu.id);
  }

  const code = randCode(8);
  const format = `${teamSize}v${teamSize}`;
  const expiresAt = nowPlusMinutes(30);

  await query(
    "INSERT INTO fights(code, team_size, format, status, created_at, expires_at, poster_ids, poster_team_name, match_mode) VALUES ($1,$2,$3,'OPEN',NOW(),$4,$5,$6,$7)",
    [code, teamSize, format, expiresAt, ids, u.team_name, matchMode]
  );

  res.json({ ok: true, code });
});

// Repost
app.post("/api/fights/:code/repost", authMiddleware, async (req, res) => {
  const code = String(req.params.code);
  const r = await query("SELECT * FROM fights WHERE code=$1", [code]);
  const fight = r.rows[0];
  if (!fight) return res.status(404).json({ error: "not found" });
  if (!(fight.poster_ids || []).includes(req.auth.id)) return res.status(403).json({ error: "not your fight" });
  if (fight.status !== "OPEN") return res.status(400).json({ error: "not open" });

  const expiresAt = nowPlusMinutes(30);
  await query("UPDATE fights SET created_at=NOW(), expires_at=$1 WHERE code=$2", [expiresAt, code]);
  res.json({ ok: true });
});

// Remove open fight
app.delete("/api/fights/:code", authMiddleware, async (req, res) => {
  const code = String(req.params.code);
  const r = await query("SELECT * FROM fights WHERE code=$1", [code]);
  const fight = r.rows[0];
  if (!fight) return res.status(404).json({ error: "not found" });
  if (!(fight.poster_ids || []).includes(req.auth.id)) return res.status(403).json({ error: "not your fight" });

  await query("DELETE FROM fights WHERE code=$1", [code]);
  res.json({ ok: true });
});

// Accept fight: provide teammateUsernames excluding self
app.post("/api/fights/:code/accept", authMiddleware, async (req,res)=>{
  const code = String(req.params.code);
  const meId = req.auth.id;
  const usernames = Array.isArray(req.body?.usernames) ? req.body.usernames : [];
  const cleanNames = usernames.map(x=>String(x||"").trim()).filter(Boolean);

  // load fight
  const fr = await query("SELECT * FROM fights WHERE code=$1", [code]);
  const fight = fr.rows[0];
  if(!fight) return res.status(404).json({ error:"Not found" });
  if(fight.status !== "OPEN") return res.status(400).json({ error:"not open" });

  // Resolve accepter ids: includes acceptor + teammates (team_size-1)
  const needTeammates = Math.max(0, (fight.team_size||1) - 1);
  if(needTeammates > 0 && cleanNames.length !== needTeammates){
    return res.status(400).json({ error:`Need ${needTeammates} teammate username(s)` });
  }

  // Fetch teammates by username case-insensitive
  const accepterIds = [meId];
  if(needTeammates){
    const r = await query("SELECT id, username FROM users WHERE LOWER(username) = ANY($1)", [cleanNames.map(n=>n.toLowerCase())]);
    if(r.rows.length !== needTeammates){
      return res.status(400).json({ error:"All teammate usernames must be registered" });
    }
    for(const u of r.rows){
      if(!accepterIds.includes(u.id)) accepterIds.push(u.id);
    }
    if(accepterIds.length !== 1 + needTeammates){
      return res.status(400).json({ error:"Duplicate teammate usernames not allowed" });
    }
  }

  // Make sure acceptor isn't on poster team
  if((fight.poster_ids||[]).includes(meId)) return res.status(400).json({ error:"Poster team can't accept its own fight" });

  // Choose location
  const LOCS = ["South of Simiran","West of Hintenfau","North of White View","West of Ottenhal","South West of Espenhal","North of Tolenque","South of Hintenfau","South of Ottenhal"];
  const location = String(fight.match_mode||"LAWLESS").toUpperCase()==="LAWFUL" ? "Lawful Location" : LOCS[Math.floor(Math.random()*LOCS.length)];

  const endsAt = new Date(Date.now() + 30*60*1000).toISOString();

  // Update fight to matched
  await query(
    "UPDATE fights SET status='MATCHED', accepter_ids=$1, accepted_at=NOW(), location=$2, match_expires_at=$3 WHERE code=$4",
    [accepterIds, location, endsAt, code]
  );

    if(String(fight.match_mode||"LAWLESS").toUpperCase()==="LAWFUL"){
    await query("INSERT INTO match_messages(code, side, alias, text) VALUES ($1,'SYSTEM','Herald',$2)", [code, "This is a lawful match. Please coordinate with your opponent to pick a location to engage in combat. Good luck!"]);
  }

  // notify all participants
  const participantIds = Array.from(new Set([...(fight.poster_ids||[]), ...accepterIds]));
  for(const uid of participantIds){
    await notifyUser(uid, "MATCH_READY", { code, team_size: fight.team_size, meetup_location: location });
  }
  io.to(`match:${code}`).emit("matchReady", { code, team_size: fight.team_size, location, match_expires_at: endsAt });

  res.json({ ok:true, code });
});

// Fight/match detail (for match page)
app.get("/api/fights/:code", authMiddleware, async (req,res)=>{
  const code = String(req.params.code);
  let r = await query("SELECT * FROM fights WHERE code=$1", [code]);
  let fight = r.rows[0] || null;
  let archived = false;

  if(!fight){
    const hr = await query("SELECT * FROM match_history WHERE code=$1", [code]);
    if(hr.rows[0]){ fight = { ...hr.rows[0], status:"ARCHIVED" }; archived = true; }
  }
  if(!fight) return res.status(404).json({ error:"not found" });

  const me = await getUserById(req.auth.id);
  const allowed = await isUserInFight(req.auth.id, fight) || (me && isAdmin(me.username));
  if(!allowed) return res.status(403).json({ error:"Not a participant" });

  const my_side = (fight.poster_ids||[]).includes(req.auth.id) ? "POSTER" : ((fight.accepter_ids||[]).includes(req.auth.id) ? "ACCEPTER" : "ADMIN");
  const out = {
    code: fight.code,
    team_size: fight.team_size,
    format: fight.format,
    status: fight.status,
    match_mode: fight.match_mode || 'LAWLESS',
    location: fight.location,
    match_expires_at: fight.match_expires_at,
    poster_team_name: fight.poster_team_name,
    accepter_team_name: fight.accepter_team_name,
    poster_confirm: fight.poster_confirm,
    accepter_confirm: fight.accepter_confirm,
    my_side
  };
  res.json({ fight: out, archived });
});

// Chat
app.post("/api/fights/:code/chat", authMiddleware, async (req, res) => {
  const code = String(req.params.code);
  const text = String(req.body?.text || "").trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: "text required" });

  const fr = await query("SELECT * FROM fights WHERE code=$1", [code]);
  const fight = fr.rows[0];
  if (!fight) return res.status(404).json({ error: "not found" });
  if (fight.status !== "MATCHED") return res.status(400).json({ error: "chat locked" });

  if (!(await isUserInFight(req.auth.id, fight))) return res.status(403).json({ error: "Not a participant" });

  const side = (fight.poster_ids || []).includes(req.auth.id) ? "POSTER" : "ACCEPTER";
  // alias is generated client-side; server stores null to keep anon in DB
  await query("INSERT INTO match_messages(code, side, alias, text) VALUES ($1,$2,NULL,$3)", [code, side, text]);
  io.to(`match:${code}`).emit("chat", { side, alias: null, text, at: new Date().toISOString() });
  res.json({ ok: true });
});

// Winner confirm (single per team, allow reset if mismatch)
app.post("/api/fights/:code/confirm", authMiddleware, async (req, res) => {
  const code = String(req.params.code);
  const choice = String(req.body?.choice || ""); // WIN or LOSE
  if (!["WIN", "LOSE"].includes(choice)) return res.status(400).json({ error: "invalid choice" });

  const fr = await query("SELECT * FROM fights WHERE code=$1", [code]);
  const fight = fr.rows[0];
  if (!fight) return res.status(404).json({ error: "not found" });
  if (fight.status !== "MATCHED") return res.status(400).json({ error: "not active" });
  if (!(await isUserInFight(req.auth.id, fight))) return res.status(403).json({ error: "Not a participant" });

  const side = (fight.poster_ids || []).includes(req.auth.id) ? "POSTER" : "ACCEPTER";
  if (side === "POSTER") {
    if (fight.poster_confirm) return res.json({ ok: true, message: "already selected" });
    await query("UPDATE fights SET poster_confirm=$1 WHERE code=$2", [choice, code]);
  } else {
    if (fight.accepter_confirm) return res.json({ ok: true, message: "already selected" });
    await query("UPDATE fights SET accepter_confirm=$1 WHERE code=$2", [choice, code]);
  }

  // broadcast nudge
  io.to(`match:${code}`).emit("confirm", { side, choice });

  // reload current fight
  const fr2 = await query("SELECT * FROM fights WHERE code=$1", [code]);
  const f2 = fr2.rows[0];

  const pc = f2.poster_confirm;
  const ac = f2.accepter_confirm;

  if (pc && ac) {
    // If they disagree (both WIN or both LOSE), reset and require decide
    if (pc === ac) {
      await query("UPDATE fights SET poster_confirm=NULL, accepter_confirm=NULL WHERE code=$1", [code]);
      await query("INSERT INTO match_messages(code, side, alias, text) VALUES ($1,'SYSTEM',NULL,$2)", [code, "A winner of the fight must be decided. Please select again."]);
      io.to(`match:${code}`).emit("chat", { side: "SYSTEM", alias: "System", text: "A winner of the fight must be decided. Please select again.", at: new Date().toISOString() });
      return res.json({ ok: true, reset: true });
    }

    // Determine winner: if poster says WIN and accepter says LOSE -> poster victory. Else accepter victory.
    const posterWon = (pc === "WIN" && ac === "LOSE");
    const resultPoster = posterWon ? "VICTORY" : "DEFEAT";
    const resultAccepter = posterWon ? "DEFEAT" : "VICTORY";
    const delta = 15;

    // Apply ratings
    await query("UPDATE users SET rating = rating + $1 WHERE id = ANY($2)", [delta, f2.poster_ids]);
    await query("UPDATE users SET rating = rating - $1 WHERE id = ANY($2)", [delta, f2.accepter_ids]);

    // Mark concluded
    await query("UPDATE fights SET status='CONCLUDED', result=$1, rating_delta=$2 WHERE code=$3", [posterWon ? "POSTER" : "ACCEPTER", delta, code]);

    // Archive and remove from active fights
    await archiveFight(code, posterWon ? "POSTER" : "ACCEPTER", delta);
    await query("DELETE FROM fights WHERE code=$1", [code]);

    // Notify everyone with result perspective (payload has result per user)
    for (const uid of f2.poster_ids) await notifyUser(uid, "FIGHT_CONCLUDED", { code, result: resultPoster, ratingDelta: delta });
    for (const uid of f2.accepter_ids) await notifyUser(uid, "FIGHT_CONCLUDED", { code, result: resultAccepter, ratingDelta: delta });

    io.to(`match:${code}`).emit("matchConcluded", { winner: posterWon ? "POSTER" : "ACCEPTER", delta });

    return res.json({ ok: true, concluded: true });
  }

  return res.json({ ok: true });
});


// Report a bug/issue (users)
app.post("/api/report", authMiddleware, async (req,res)=>{
  const u = await getUserById(req.auth.id);
  if(!u || u.banned) return res.status(403).json({ error:"banned" });
  const message = String(req.body?.message||"").trim().slice(0, 1000);
  if(!message) return res.status(400).json({ error:"message required" });
  await query("INSERT INTO reports(user_id, username, message) VALUES ($1,$2,$3)", [u.id, u.username, message]);
  res.json({ ok:true });
});


app.get("/api/fights/:code/history", authMiddleware, async (req,res)=>{
  const code=String(req.params.code);
  // Ensure access via existing /api/fights/:code check
  const base = await query("SELECT * FROM fights WHERE code=$1", [code]);
  let fight = base.rows[0] || null;
  let archived = false;
  if(!fight){
    const hr = await query("SELECT * FROM match_history WHERE code=$1", [code]);
    if(hr.rows[0]){ fight = { ...hr.rows[0], status:"ARCHIVED" }; archived = true; }
  }
  if(!fight) return res.status(404).json({ error:"not found" });
  const me = await getUserById(req.auth.id);
  const allowed = await isUserInFight(req.auth.id, fight) || (me && isAdmin(me.username));
  if(!allowed) return res.status(403).json({ error:"Not a participant" });

  const msgs = await query("SELECT side, alias, text, at FROM match_messages WHERE code=$1 ORDER BY at ASC", [code]);
  res.json({ chat_log: msgs.rows, chat_locked: (fight.status==="CONCLUDED"||fight.status==="ARCHIVED") ? true : false, archived });
});


app.get("/api/fights/:code/reveal", authMiddleware, async (req,res)=>{
  const code=String(req.params.code);
  let r = await query("SELECT * FROM fights WHERE code=$1", [code]);
  let fight=r.rows[0] || null;
  if(!fight){
    const hr = await query("SELECT * FROM match_history WHERE code=$1", [code]);
    if(hr.rows[0]) fight = { ...hr.rows[0], status:"ARCHIVED" };
  }
  if(!fight) return res.status(404).json({ error:"not found" });

  const me = await getUserById(req.auth.id);
  const allowed = await isUserInFight(req.auth.id, fight) || (me && isAdmin(me.username));
  if(!allowed) return res.status(403).json({ error:"Not a participant" });

  const posterUsers = (await query("SELECT username, team_name, rating FROM users WHERE id = ANY($1)", [fight.poster_ids||[]])).rows;
  const accepterUsers = (await query("SELECT username, team_name, rating FROM users WHERE id = ANY($1)", [fight.accepter_ids||[]])).rows;

  const winner_team = (fight.result==="DRAW"||fight.final_status==="DRAW") ? "DRAW" : (fight.result==="POSTER" ? "POSTER" : (fight.result==="ACCEPTER" ? "ACCEPTER" : null));

  const participants = [...posterUsers.map(x=>({username:x.username, rating:x.rating||0})), ...accepterUsers.map(x=>({username:x.username, rating:x.rating||0}))];
  const my_side = (fight.poster_ids||[]).includes(req.auth.id) ? 'POSTER' : ((fight.accepter_ids||[]).includes(req.auth.id) ? 'ACCEPTER' : 'ADMIN');
  res.json({
    meetup_location: fight.location,
    location: fight.location,
    my_side,
    participants,
    winner_team,
    rating_delta: fight.rating_delta || 0,
    poster: { team_name: fight.poster_team_name || (posterUsers[0]?.team_name||"Team"), usernames: posterUsers.map(x=>x.username) },
    accepter: { team_name: fight.accepter_team_name || (accepterUsers[0]?.team_name||"Team"), usernames: accepterUsers.map(x=>x.username) }
  });
});


app.post("/api/fights/:code/vote-winner", authMiddleware, async (req,res)=>{
  const code=String(req.params.code);
  const vote = String(req.body?.vote||"").toUpperCase(); // WIN or LOSS
  if(vote!=="WIN" && vote!=="LOSS") return res.status(400).json({ error:"invalid vote" });

  const r = await query("SELECT * FROM fights WHERE code=$1", [code]);
  const fight = r.rows[0];
  if(!fight) return res.status(404).json({ error:"not found" });
  if(fight.status!=="MATCHED") return res.status(400).json({ error:"match not active" });

  const meId=req.auth.id;
  const isPoster = (fight.poster_ids||[]).includes(meId);
  const isAccepter = (fight.accepter_ids||[]).includes(meId);
  if(!isPoster && !isAccepter) return res.status(403).json({ error:"Not a participant" });

  const col = isPoster ? "poster_confirm" : "accepter_confirm";
  await query(`UPDATE fights SET ${col}=$1 WHERE code=$2`, [vote, code]);

  // Reload
  const r2 = await query("SELECT poster_confirm, accepter_confirm FROM fights WHERE code=$1", [code]);
  const pc = r2.rows[0].poster_confirm;
  const ac = r2.rows[0].accepter_confirm;

  if((pc && !ac) || (!pc && ac)){
    await query("INSERT INTO match_messages(code, side, alias, text) VALUES ($1,'SYSTEM','Herald',$2)", [code, 'Please confirm match has concluded by confirming a loss or victory.']);
    io.to(`match:${code}`).emit('chat', { side:'SYSTEM', alias:'Herald', text:'Please confirm match has concluded by confirming a loss or victory.', at:new Date().toISOString() });
  }

  // If both set
  if(pc && ac){
    // conflict
    if(pc===ac){
      await query("UPDATE fights SET poster_confirm=NULL, accepter_confirm=NULL WHERE code=$1", [code]);
      await query("INSERT INTO match_messages(code, side, alias, text) VALUES ($1,'SYSTEM','System','A winner of the fight must be decided. Please select a winner.')", [code]);
      io.to(`match:${code}`).emit("chat", { side:"SYSTEM", alias:"System", text:"A winner of the fight must be decided. Please select a winner.", at:new Date().toISOString() });
      io.to(`match:${code}`).emit("winnerUpdate", { conflict:true });
      return res.json({ ok:true, conflict:true });
    }

    // decide winner team
    let winner = null;
    if(pc==="WIN" && ac==="LOSS") winner="POSTER";
    if(pc==="LOSS" && ac==="WIN") winner="ACCEPTER";
    if(!winner){
      // Shouldn't happen, but safe
      await query("UPDATE fights SET poster_confirm=NULL, accepter_confirm=NULL WHERE code=$1", [code]);
      io.to(`match:${code}`).emit("winnerUpdate", { conflict:true });
      return res.json({ ok:true, conflict:true });
    }

    // conclude: compute rating delta fixed 15 for now
    const delta = 15;
    await query("UPDATE fights SET status='CONCLUDED', result=$1, rating_delta=$2 WHERE code=$3", [winner, delta, code]);

    // Apply ratings
    const winnerIds = winner==="POSTER" ? (fight.poster_ids||[]) : (fight.accepter_ids||[]);
    const loserIds = winner==="POSTER" ? (fight.accepter_ids||[]) : (fight.poster_ids||[]);
    if(winnerIds.length) await query("UPDATE users SET rating = rating + $1 WHERE id = ANY($2)", [delta, winnerIds]);
    if(loserIds.length) await query("UPDATE users SET rating = GREATEST(0, rating - $1) WHERE id = ANY($2)", [delta, loserIds]);

    // Archive into match_history
    const full = await query("SELECT * FROM fights WHERE code=$1", [code]);
    const f = full.rows[0];
    try{
      await query(`INSERT INTO match_history(code, team_size, format, created_at, accepted_at, concluded_at, location, poster_ids, accepter_ids, poster_team_name, accepter_team_name, result, final_status, rating_delta)
        VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (code) DO NOTHING`,
        [f.code, f.team_size, f.format, f.created_at, f.accepted_at, f.location, f.poster_ids, f.accepter_ids, f.poster_team_name, f.accepter_team_name, winner, (winner==="DRAW"?"DRAW":"CONCLUDED"), delta]
      );
    }catch(e){ console.error("match_history insert failed", e); }
// Notify all participants + remove MATCH_READY + add FIGHT_CONCLUDED notifications
    const participants = Array.from(new Set([...(fight.poster_ids||[]),...(fight.accepter_ids||[])]));
    const usersR = await query("SELECT id, username, rating FROM users WHERE id = ANY($1)", [participants]);
    const userMap = new Map(usersR.rows.map(r=>[r.id, r]));
    const participantList = participants.map(id=>{
      const u=userMap.get(id);
      return u?{ username:u.username, rating:u.rating }: { username:"Unknown", rating:0 };
    });

    for(const uid of participants){
      // remove "match found/open match" notification for this match
      await query("DELETE FROM notifications WHERE user_id=$1 AND type='MATCH_READY' AND payload->>'code'=$2", [uid, code]);

      const isWinner = (winner==="POSTER") ? (fight.poster_ids||[]).includes(uid) : (fight.accepter_ids||[]).includes(uid);
      const outcome = isWinner ? "VICTORY" : "DEFEAT";
      const signedDelta = isWinner ? delta : -delta;

      if(winner!=="DRAW"){
        if(isWinner) await query("UPDATE users SET wins = COALESCE(wins,0)+1 WHERE id=$1", [uid]);
        else await query("UPDATE users SET losses = COALESCE(losses,0)+1 WHERE id=$1", [uid]);
      }

      const payload = {
        code,
        outcome,
        rating_delta: signedDelta,
        location: f.location || "",
        participants: participantList,
        at: new Date().toISOString()
      };

      await notifyUser(uid, "FIGHT_CONCLUDED", payload);
      io.to(`user:${uid}`).emit("forceCloseMatch", payload);
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
  if((pe && !r2.rows[0].accepter_extend) || (!pe && r2.rows[0].accepter_extend)){
    await query("INSERT INTO match_messages(code, side, alias, text) VALUES ($1,'SYSTEM','Herald',$2)", [code, 'A 15 minute match extension has been requested.']);
    io.to(`match:${code}`).emit('chat', { side:'SYSTEM', alias:'Herald', text:'A 15 minute match extension has been requested.', at:new Date().toISOString() });
  }
  const ae=r2.rows[0].accepter_extend;
  const cnt=r2.rows[0].extension_count||0;

  if(pe && ae){
    // apply extension
    const newEnd = new Date((fight.match_expires_at ? Date.parse(fight.match_expires_at) : Date.now()) + 15*60*1000);
    await query("UPDATE fights SET match_expires_at=$1, extension_count=extension_count+1, poster_extend=FALSE, accepter_extend=FALSE WHERE code=$2", [newEnd.toISOString(), code]);
    await query("INSERT INTO match_messages(code, side, alias, text) VALUES ($1,'SYSTEM','Herald',$2)", [code, "Granted 15 minute match extension."]);
    io.to(`match:${code}`).emit("chat", { side:"SYSTEM", alias:"Herald", text:"Granted 15 minute match extension.", at:new Date().toISOString() });
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
  await query("UPDATE users SET rating=$1, wins=0, losses=0 WHERE banned=false", [r]);
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
  // Auto-auth from cookie if present (for match iframe)
  try{
    const ck = parseCookies(socket.handshake?.headers?.cookie);
    const tok = ck.token;
    if(tok){
      const payload = jwt.verify(tok, JWT_SECRET);
      socket.data.userId = payload.id;
      socket.data.username = payload.username;
      socket.join(`user:${payload.id}`);
    }
  }catch(e){}
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

  socket.on("joinUserRoom", async (id) => {
    const userId = socket.data.userId;
    if(!userId) return;
    if(String(id)!==String(userId)) return;
    socket.join(`user:${userId}`);
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
