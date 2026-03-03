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

async function archiveFight(code, resultTeam, ratingDelta) {
  // Copy from fights -> match_history if not exists
  const fr = await query("SELECT * FROM fights WHERE code=$1", [code]);
  const fight = fr.rows[0];
  if (!fight) return;

  const ex = await query("SELECT 1 FROM match_history WHERE code=$1", [code]);
  if (ex.rows.length) return;

  // Ensure resultTeam is non-null
  const rt = resultTeam || "DRAW";

  await archiveFight(code, winner, delta);
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
