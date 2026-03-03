/* Rise of Agon PvP Finder (Windows-friendly v5)
   - Open fights: participants cannot accept and do not see Accept.
   - Open list reveals creator team usernames ONLY to participants; others see Anonymous.
   - Full background cover image.
   - Header title: ⚔️Rise of Agon PvP Finder
   - Notifications concluded format: Result: VICTORY/DEFEAT (+/-15 Rating) and Participants with ratings.
   - Match iframe tells parent to close popup when concluded.
*/
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const http = require("http");
const { Server } = require("socket.io");

const low = require("lowdb");
const FileSync = require("lowdb/adapters/FileSync");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const PORT = Number(process.env.PORT || 3000);

const OPEN_FIGHT_TTL_MINUTES = 30;
const MATCH_TTL_MINUTES = 30;
const EXTEND_MINUTES = 15;
const EXTEND_CAP_MINUTES = 30;
const RATING_DELTA = 15;

const DB_FILE = path.join(__dirname, "db.json");
const adapter = new FileSync(DB_FILE);
const db = low(adapter);
db.defaults({ users: [], fights: [], notifications: [], counters: { user: 0, fight: 0, notif: 0 } }).write();

function nowIso(){ return new Date().toISOString(); }
function nowMs(){ return Date.now(); }
function minutesToMs(m){ return m * 60 * 1000; }
function uniq(arr){ return Array.from(new Set(arr)); }

function nextId(key){
  const c = db.get("counters").value();
  c[key] = (c[key] || 0) + 1;
  db.set("counters", c).write();
  return c[key];
}
function makeCode(len=8){
  return crypto.randomBytes(Math.ceil(len*0.75)).toString("base64")
    .replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"").slice(0,len);
}

function getUserByUsername(username){ return db.get("users").find({ username }).value(); }
function getUserById(id){ return db.get("users").find({ id }).value(); }
function getFightByCode(code){ return db.get("fights").find({ code }).value(); }
function saveFight(code, fight){ db.get("fights").find({ code }).assign(fight).write(); }

function authMiddleware(req,res,next){
  const token = req.cookies.token;
  if(!token) return res.status(401).json({ error:"Not authenticated" });
  try{ req.user = jwt.verify(token, JWT_SECRET); return next(); }
  catch{ return res.status(401).json({ error:"Invalid token" }); }
}
function optionalAuth(req,_res,next){
  const token = req.cookies.token;
  if(!token) return next();
  try{ req.user = jwt.verify(token, JWT_SECRET); }catch{}
  next();
}

function createNotification(userId, type, payload){
  const notif = { id: nextId("notif"), user_id: userId, type, payload, created_at: nowIso(), read: 0 };
  db.get("notifications").push(notif).write();
  io.to(`user:${userId}`).emit("notification", notif);
  return notif;
}
function removeMatchReadyNotifsForCode(code){
  const all = db.get("notifications").value();
  const kept = all.filter(n => !(n.type === "MATCH_READY" && n.payload && n.payload.code === code));
  if(kept.length !== all.length) db.set("notifications", kept).write();
}

const MEETUP_LOCATIONS = [
  "South of Simiran","West of Hintenfau","North of White View","West of Ottenhal",
  "South West of Espenhal","North of Tolenque","South of Hintenfau","South of Ottenhal"
];
function randomMeetupLocation(){ return MEETUP_LOCATIONS[Math.floor(Math.random()*MEETUP_LOCATIONS.length)]; }

const CHAT_ALIASES = [
  "Akathar","Guardian","Fire Dragon","Dark Dragon","Devil","Demon Lord","Goblin Fighter","Goblin Warlord","Goblin Scout",
  "Brown Bear","Tomb Iklit","Human Guildmaster","Deadeye","Manscorpion","Gorra Dar","Sand Iklit","Erodach","Baradron",
  "Forest Golem","Troll","Troll Lord","Great White","Brownie","Goblin Shaman","Giant Spider","Windlord","Centaur",
  "Ancient","Beastman","Crog","Khamset","Minotaur","Kraken"
];
function assignChatAliases(teamPosterIds, teamAccepterIds){
  const pool = CHAT_ALIASES.slice();
  for(let i=pool.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [pool[i],pool[j]]=[pool[j],pool[i]];
  }
  const mapping = {};
  const all = [...teamPosterIds, ...teamAccepterIds];
  for(let i=0;i<all.length;i++) mapping[String(all[i])] = pool[i % pool.length] || `Fighter${i+1}`;
  return mapping;
}

function getSides(f){ return { posterIds: f.creator_team_user_ids || [], accepterIds: f.accepter_team_user_ids || [] }; }
function participantSide(f, userId){
  const { posterIds, accepterIds } = getSides(f);
  if(posterIds.includes(userId)) return "POSTER";
  if(accepterIds.includes(userId)) return "ACCEPTER";
  return null;
}
function systemEmitChat(code, text){
  io.to(`fight:${code}`).emit("chat", { at: nowIso(), alias: "Herald", side: "SYSTEM", text });
}

function computeOpenExpiresAt(createdAtIso){
  return new Date(Date.parse(createdAtIso) + minutesToMs(OPEN_FIGHT_TTL_MINUTES)).toISOString();
}
function computeMatchEndsAt(acceptedAtIso){
  return new Date(Date.parse(acceptedAtIso) + minutesToMs(MATCH_TTL_MINUTES)).toISOString();
}

function sweepExpiredOpenFights(){
  const fights = db.get("fights").value();
  const now = nowMs();
  let changed = false;
  for(const f of fights){
    if(f.status==="OPEN"){
      const exp = f.open_expires_at ? Date.parse(f.open_expires_at) : Date.parse(computeOpenExpiresAt(f.created_at));
      if(!f.open_expires_at){ f.open_expires_at = new Date(exp).toISOString(); changed = true; }
      if(now >= exp){ f.status="EXPIRED"; f.expired_at = nowIso(); changed = true; }
    }
  }
  if(changed) db.set("fights", fights).write();
}

function participantsWithRatings(ids){
  return ids.map(id => {
    const u = getUserById(id);
    if(!u) return null;
    const r = Number.isFinite(u.rating) ? u.rating : 1000;
    return `${u.username} (${r})`;
  }).filter(Boolean);
}

function concludeAsDraw(fight, reasonText){
  fight.status="CONCLUDED";
  fight.winner_team="DRAW";
  fight.rating_applied=1;
  fight.chat_locked=1;
  fight.concluded_at=nowIso();
  saveFight(fight.code, fight);

  removeMatchReadyNotifsForCode(fight.code);

  const { posterIds, accepterIds } = getSides(fight);
  const allIds = uniq([...posterIds, ...accepterIds]);
  const participants = participantsWithRatings(allIds);

  for(const uid of allIds){
    createNotification(uid, "FIGHT_CONCLUDED", {
      code: fight.code,
      location: fight.meetup_location,
      result: "DRAW",
      rating_delta: 0,
      participants,
      at: nowIso()
    });
  }

  systemEmitChat(fight.code, reasonText || "⏳ The battle has timed out. Result: DRAW.");
  io.to(`fight:${fight.code}`).emit("fightConcluded", { code: fight.code, winner_team: "DRAW" });
}

function checkAcceptedTimeoutAndMaybeDraw(fight){
  if(!fight || fight.status!=="ACCEPTED") return fight;
  const endsAt = fight.match_ends_at ? Date.parse(fight.match_ends_at) : Date.parse(computeMatchEndsAt(fight.accepted_at));
  if(!fight.match_ends_at){ fight.match_ends_at = new Date(endsAt).toISOString(); saveFight(fight.code, fight); }
  if(nowMs() < endsAt) return fight;
  concludeAsDraw(fight, "⏳ The battle has timed out. Result: DRAW.");
  return fight;
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(cookieParser());

app.use("/audio", express.static(path.join(__dirname, "audio")));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.get("/match/:code", (_req,res)=>res.sendFile(path.join(__dirname,"public","match.html")));

// Auth: Login or Register
app.post("/api/auth", (req,res)=>{
  const { username, password } = req.body || {};
  if(!username || !password) return res.status(400).json({ error:"username and password required" });
  const uname = String(username).trim();
  const pw = String(password);
  if(uname.length < 3) return res.status(400).json({ error:"username too short" });
  if(pw.length < 6) return res.status(400).json({ error:"password too short" });

  const existing = getUserByUsername(uname);
  if(existing){
    const ok = bcrypt.compareSync(pw, existing.password_hash);
    if(!ok) return res.status(401).json({ error:"wrong password" });
    const payload = { id: existing.id, username: existing.username };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn:"7d" });
    res.cookie("token", token, { httpOnly:true, sameSite:"lax" });
    return res.json({ ok:true, mode:"login", user: payload });
  }

  const user = {
    id: nextId("user"),
    username: uname,
    password_hash: bcrypt.hashSync(pw, 10),
    rating: 1000,
    team_name: `Team of ${uname}`,
    created_at: nowIso()
  };
  db.get("users").push(user).write();
  const payload = { id: user.id, username: user.username };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn:"7d" });
  res.cookie("token", token, { httpOnly:true, sameSite:"lax" });
  return res.json({ ok:true, mode:"register", user: payload });
});

app.post("/api/logout", (_req,res)=>{ res.clearCookie("token"); res.json({ ok:true }); });

app.get("/api/me", (req,res)=>{
  const token=req.cookies.token;
  if(!token) return res.json({ authenticated:false });
  try{
    const payload=jwt.verify(token, JWT_SECRET);
    const user=getUserById(payload.id);
    if(!user) return res.json({ authenticated:false });
    return res.json({ authenticated:true, user:{ id:user.id, username:user.username, rating:user.rating, team_name:user.team_name }});
  }catch{ return res.json({ authenticated:false }); }
});

app.post("/api/me/team-name", authMiddleware, (req,res)=>{
  const name = String(req.body?.team_name || "").trim().slice(0,30);
  if(!name) return res.status(400).json({ error:"team_name required" });
  const u=getUserById(req.user.id);
  if(!u) return res.status(404).json({ error:"user not found" });
  db.get("users").find({ id:req.user.id }).assign({ team_name:name }).write();
  res.json({ ok:true, team_name:name });
});

// fights
app.get("/api/fights/open", optionalAuth, (req,res)=>{
  sweepExpiredOpenFights();
  const meId = req.user?.id || null;

  const fights = db.get("fights")
    .filter(f=>f.status==="OPEN")
    .orderBy(["created_at"],["desc"])
    .take(50)
    .map(f=>{
      const creatorIds = f.creator_team_user_ids || [];
      const isMine = meId ? (f.creator_user_id === meId) : false;
      const isParticipant = meId ? creatorIds.includes(meId) : false;
      const creatorNames = creatorIds.map(getUserById).filter(Boolean).map(u=>u.username);
      return {
        code: f.code,
        team_size: f.team_size,
        created_at: f.created_at,
        open_expires_at: f.open_expires_at || computeOpenExpiresAt(f.created_at),
        is_mine: isMine,
        is_participant: isParticipant,
        creator_names: isParticipant ? creatorNames : null
      };
    }).value();

  res.json({ fights });
});

app.get("/api/fights/mine-open", authMiddleware, (req,res)=>{
  sweepExpiredOpenFights();
  const f = db.get("fights").find(x=>x.status==="OPEN" && x.creator_user_id===req.user.id).value();
  if(!f) return res.json({ has_open:false });
  res.json({ has_open:true, fight:{ code:f.code, team_size:f.team_size, created_at:f.created_at, open_expires_at: f.open_expires_at || computeOpenExpiresAt(f.created_at) }});
});

app.post("/api/fights/create", authMiddleware, (req,res)=>{
  sweepExpiredOpenFights();
  const existingOpen = db.get("fights").find(f=>f.status==="OPEN" && f.creator_user_id===req.user.id).value();
  if(existingOpen) return res.status(400).json({ error:"You already have an active posted fight. Remove it first." });

  const n = Number(req.body?.teamSize);
  const teammateUsernames = req.body?.teammateUsernames;
  if(!Number.isFinite(n) || n < 1 || n > 50) return res.status(400).json({ error:"teamSize must be 1..50" });
  if(n>1){
    if(!Array.isArray(teammateUsernames) || teammateUsernames.length !== (n-1)){
      return res.status(400).json({ error:`For ${n}v${n}, provide exactly ${n-1} teammate usernames (excluding you).` });
    }
  }

  const creatorId=req.user.id;
  const teamPosterIds=[creatorId];
  if(n>1){
    const seen=new Set([req.user.username.toLowerCase()]);
    for(const uname of teammateUsernames){
      if(!uname || typeof uname !== "string") return res.status(400).json({ error:"Invalid teammate username" });
      const key=uname.toLowerCase();
      if(seen.has(key)) return res.status(400).json({ error:"Duplicate teammate username" });
      seen.add(key);
      const u=getUserByUsername(uname);
      if(!u) return res.status(400).json({ error:`Unknown user: ${uname}` });
      if(u.id===creatorId) return res.status(400).json({ error:"Do not list yourself as a teammate" });
      teamPosterIds.push(u.id);
    }
  }

  let code=makeCode(8);
  while(getFightByCode(code)) code=makeCode(8);

  const created=nowIso();
  const fight={
    id: nextId("fight"),
    code,
    creator_user_id: creatorId,
    team_size: n,
    creator_team_user_ids: teamPosterIds,
    status:"OPEN",
    created_at: created,
    open_expires_at: computeOpenExpiresAt(created),

    accepted_at:null,
    accepter_user_id:null,
    accepter_team_user_ids:null,
    meetup_location:null,
    match_ends_at:null,

    winner_team:null,
    rating_applied:0,
    concluded_at:null,

    chat_aliases:{},
    chat_log:[],
    chat_locked:0,

    vote_state:"OPEN",
    side_votes:{ POSTER:null, ACCEPTER:null },
    side_locked:{ POSTER:0, ACCEPTER:0 },

    extend_requests:{ POSTER:0, ACCEPTER:0 },
    extend_cycle:0
  };
  db.get("fights").push(fight).write();
  res.json({ ok:true, fight:{ code, team_size:n, created_at: fight.created_at, open_expires_at: fight.open_expires_at }});
});

app.post("/api/fights/:code/repost", authMiddleware, (req,res)=>{
  sweepExpiredOpenFights();
  const code=String(req.params.code);
  const fight=getFightByCode(code);
  if(!fight) return res.status(404).json({ error:"Fight not found" });
  if(fight.status!=="OPEN") return res.status(400).json({ error:"Fight is not open" });
  if(fight.creator_user_id!==req.user.id) return res.status(403).json({ error:"Not allowed" });

  const created=nowIso();
  fight.created_at=created;
  fight.open_expires_at=computeOpenExpiresAt(created);
  saveFight(code, fight);
  res.json({ ok:true, fight:{ code, created_at: fight.created_at, open_expires_at: fight.open_expires_at }});
});

app.delete("/api/fights/:code", authMiddleware, (req,res)=>{
  sweepExpiredOpenFights();
  const code=String(req.params.code);
  const fight=getFightByCode(code);
  if(!fight) return res.status(404).json({ error:"Fight not found" });
  if(fight.status!=="OPEN") return res.status(400).json({ error:"Only open fights can be removed" });
  if(fight.creator_user_id!==req.user.id) return res.status(403).json({ error:"Not allowed" });

  db.set("fights", db.get("fights").value().filter(f=>f.code!==code)).write();
  res.json({ ok:true });
});

app.post("/api/fights/:code/accept", authMiddleware, (req,res)=>{
  sweepExpiredOpenFights();
  const code=String(req.params.code);
  const fight=getFightByCode(code);
  if(!fight) return res.status(404).json({ error:"Fight not found" });
  if(fight.status!=="OPEN") return res.status(400).json({ error:"Fight is not open" });

  const exp=Date.parse(fight.open_expires_at || computeOpenExpiresAt(fight.created_at));
  if(nowMs()>=exp){
    fight.status="EXPIRED"; fight.expired_at=nowIso(); saveFight(code, fight);
    return res.status(400).json({ error:"Fight expired" });
  }

  const teamSize=fight.team_size;
  const accepterId=req.user.id;
  const teamPosterIds=fight.creator_team_user_ids || [];

  if(teamPosterIds.includes(accepterId)) return res.status(400).json({ error:"You are already listed as a participant in this fight." });

  let teamAccepterIds=[];
  if(teamSize===1){
    teamAccepterIds=[accepterId];
  }else{
    const teammateUsernames=req.body?.teammateUsernames;
    if(!Array.isArray(teammateUsernames) || teammateUsernames.length !== (teamSize-1)){
      return res.status(400).json({ error:`For ${teamSize}v${teamSize}, provide exactly ${teamSize-1} teammate usernames (excluding you).` });
    }
    const seen=new Set([req.user.username.toLowerCase()]);
    teamAccepterIds=[accepterId];
    for(const uname of teammateUsernames){
      if(!uname || typeof uname!=="string") return res.status(400).json({ error:"Invalid teammate username" });
      const key=uname.toLowerCase();
      if(seen.has(key)) return res.status(400).json({ error:"Duplicate teammate username" });
      seen.add(key);
      const u=getUserByUsername(uname);
      if(!u) return res.status(400).json({ error:`Unknown user: ${uname}` });
      if(u.id===accepterId) return res.status(400).json({ error:"Do not list yourself as a teammate" });
      teamAccepterIds.push(u.id);
    }
    if(teamAccepterIds.some(id=>teamPosterIds.includes(id))) return res.status(400).json({ error:"Accepter team cannot include a match creator team member." });
  }

  const meetup=randomMeetupLocation();
  const acceptedAt=nowIso();

  fight.status="ACCEPTED";
  fight.accepted_at=acceptedAt;
  fight.accepter_user_id=accepterId;
  fight.accepter_team_user_ids=teamAccepterIds;
  fight.meetup_location=meetup;

  fight.chat_aliases=assignChatAliases(teamPosterIds, teamAccepterIds);
  fight.chat_log=[];
  fight.chat_locked=0;

  fight.vote_state="OPEN";
  fight.side_votes={ POSTER:null, ACCEPTER:null };
  fight.side_locked={ POSTER:0, ACCEPTER:0 };

  fight.extend_requests={ POSTER:0, ACCEPTER:0 };
  fight.extend_cycle=0;

  fight.match_ends_at=computeMatchEndsAt(acceptedAt);

  saveFight(code, fight);

  const allUserIds=uniq([...teamPosterIds, ...teamAccepterIds]);
  for(const uid of allUserIds){
    createNotification(uid, "MATCH_READY", { code, team_size: teamSize, meetup_location: meetup });
  }

  io.to(`fight:${code}`).emit("fightAccepted", { code, meetup_location: meetup, match_ends_at: fight.match_ends_at });
  res.json({ ok:true, code, meetup_location: meetup });
});

app.post("/api/fights/:code/extend", authMiddleware, (req,res)=>{
  const code=String(req.params.code);
  let fight=getFightByCode(code);
  if(!fight) return res.status(404).json({ error:"Fight not found" });

  fight = checkAcceptedTimeoutAndMaybeDraw(fight);
  if(fight.status!=="ACCEPTED") return res.status(400).json({ error:"Fight is not active" });

  const mySide=participantSide(fight, req.user.id);
  if(!mySide) return res.status(403).json({ error:"Not a participant" });

  fight.extend_requests = fight.extend_requests || { POSTER:0, ACCEPTER:0 };
  if(fight.extend_requests[mySide]) return res.status(400).json({ error:"Your side already requested an extension." });

  fight.extend_requests[mySide]=1;
  saveFight(code, fight);
  io.to(`fight:${code}`).emit("extendRequested", { side: mySide });

  if(fight.extend_requests.POSTER && fight.extend_requests.ACCEPTER){
    const currentEnd=Date.parse(fight.match_ends_at);
    const newEndCandidate=currentEnd + minutesToMs(EXTEND_MINUTES);
    const capEnd=nowMs() + minutesToMs(EXTEND_CAP_MINUTES);
    const newEnd=Math.min(newEndCandidate, capEnd);

    fight.match_ends_at=new Date(newEnd).toISOString();
    fight.extend_requests={ POSTER:0, ACCEPTER:0 };
    fight.extend_cycle=(fight.extend_cycle||0)+1;
    saveFight(code, fight);

    systemEmitChat(code, `⏳ Extension granted. The battle timer has been extended by ${EXTEND_MINUTES} minutes.`);
    io.to(`fight:${code}`).emit("extended", { match_ends_at: fight.match_ends_at });
  }

  res.json({ ok:true, match_ends_at: fight.match_ends_at });
});

app.get("/api/fights/:code", authMiddleware, (req,res)=>{
  const code=String(req.params.code);
  let fight=getFightByCode(code);
  if(!fight) return res.status(404).json({ error:"Fight not found" });

  fight = checkAcceptedTimeoutAndMaybeDraw(fight);

  const mySide=participantSide(fight, req.user.id);
  if(!mySide) return res.status(403).json({ error:"Not a participant" });

  res.json({
    code: fight.code,
    status: fight.status,
    team_size: fight.team_size,
    meetup_location: fight.meetup_location,
    my_side: mySide,
    winner_team: fight.winner_team,
    chat_locked: !!fight.chat_locked,
    match_ends_at: fight.match_ends_at
  });
});

app.get("/api/fights/:code/history", authMiddleware, (req,res)=>{
  const code=String(req.params.code);
  let fight=getFightByCode(code);
  if(!fight) return res.status(404).json({ error:"Fight not found" });

  fight = checkAcceptedTimeoutAndMaybeDraw(fight);

  const mySide=participantSide(fight, req.user.id);
  if(!mySide) return res.status(403).json({ error:"Not a participant" });

  res.json({ chat_log: fight.chat_log || [], chat_locked: !!fight.chat_locked });
});

app.get("/api/fights/:code/reveal", authMiddleware, (req,res)=>{
  const code=String(req.params.code);
  const fight=getFightByCode(code);
  if(!fight) return res.status(404).json({ error:"Fight not found" });
  if(fight.status!=="CONCLUDED") return res.status(400).json({ error:"Not concluded yet" });

  const mySide=participantSide(fight, req.user.id);
  if(!mySide) return res.status(403).json({ error:"Not a participant" });

  const { posterIds, accepterIds } = getSides(fight);
  const posterUsers=posterIds.map(getUserById).filter(Boolean);
  const accepterUsers=accepterIds.map(getUserById).filter(Boolean);

  res.json({
    code,
    meetup_location: fight.meetup_location,
    winner_team: fight.winner_team,
    poster: { team_name: (posterUsers[0]?.team_name || "Poster Team"), usernames: posterUsers.map(u=>u.username) },
    accepter:{ team_name: (accepterUsers[0]?.team_name || "Accepter Team"), usernames: accepterUsers.map(u=>u.username) }
  });
});

// notifications
app.get("/api/notifications", authMiddleware, (req,res)=>{
  const notifs=db.get("notifications").filter({ user_id: req.user.id }).orderBy(["created_at"],["desc"]).take(50).value();
  res.json({ notifications:notifs });
});
app.post("/api/notifications/:id/read", authMiddleware, (req,res)=>{
  const id=Number(req.params.id);
  const n=db.get("notifications").find({ id, user_id: req.user.id }).value();
  if(n) db.get("notifications").find({ id, user_id: req.user.id }).assign({ read:1 }).write();
  res.json({ ok:true });
});

// voting / rating
app.post("/api/fights/:code/vote-winner", authMiddleware, (req,res)=>{
  const code=String(req.params.code);
  const outcome=req.body?.outcome;
  if(outcome!=="WIN" && outcome!=="LOSS") return res.status(400).json({ error:"outcome must be WIN or LOSS" });

  let fight=getFightByCode(code);
  if(!fight) return res.status(404).json({ error:"Fight not found" });

  fight = checkAcceptedTimeoutAndMaybeDraw(fight);
  if(fight.status!=="ACCEPTED") return res.status(400).json({ error:"Fight is not active" });

  const mySide=participantSide(fight, req.user.id);
  if(!mySide) return res.status(403).json({ error:"Not a participant" });

  if(fight.vote_state==="OPEN" && fight.side_locked?.[mySide]) return res.status(400).json({ error:"Your team has already selected a result." });

  const winnerTeam=(outcome==="WIN") ? mySide : (mySide==="POSTER" ? "ACCEPTER" : "POSTER");

  fight.side_votes = fight.side_votes || { POSTER:null, ACCEPTER:null };
  fight.side_locked = fight.side_locked || { POSTER:0, ACCEPTER:0 };
  fight.side_votes[mySide] = winnerTeam;
  fight.side_locked[mySide] = 1;
  saveFight(code, fight);

  io.to(`fight:${code}`).emit("teamConfirmed", { side: mySide, outcome });
  io.to(`fight:${code}`).emit("winnerVoteNudge", { from_side: mySide });

  const a=fight.side_votes.POSTER;
  const b=fight.side_votes.ACCEPTER;

  if(a && b){
    if(a === b){
      const { posterIds, accepterIds } = getSides(fight);
      const winners = (a==="POSTER") ? posterIds : accepterIds;
      const losers  = (a==="POSTER") ? accepterIds : posterIds;

      for(const uid of winners){
        const u=getUserById(uid);
        if(u) db.get("users").find({ id: uid }).assign({ rating: (u.rating||1000) + RATING_DELTA }).write();
      }
      for(const uid of losers){
        const u=getUserById(uid);
        if(u) db.get("users").find({ id: uid }).assign({ rating: (u.rating||1000) - RATING_DELTA }).write();
      }

      fight.status="CONCLUDED";
      fight.winner_team=a;
      fight.rating_applied=1;
      fight.chat_locked=1;
      fight.concluded_at=nowIso();
      saveFight(code, fight);

      removeMatchReadyNotifsForCode(code);

      const allIds = uniq([...posterIds, ...accepterIds]);
      const participants = participantsWithRatings(allIds);

      for(const uid of allIds){
        const isWinner = winners.includes(uid);
        createNotification(uid, "FIGHT_CONCLUDED", {
          code,
          location: fight.meetup_location,
          result: isWinner ? "VICTORY" : "DEFEAT",
          rating_delta: isWinner ? +RATING_DELTA : -RATING_DELTA,
          participants,
          at: nowIso()
        });
      }

      systemEmitChat(code, "⚔️ The battle is decided.");
      io.to(`fight:${code}`).emit("fightConcluded", { code, winner_team: a });
      return res.json({ ok:true, concluded:true, winner_team:a });
    }

    // conflict reset
    fight.vote_state="CONFLICT";
    fight.side_votes={ POSTER:null, ACCEPTER:null };
    fight.side_locked={ POSTER:0, ACCEPTER:0 };
    saveFight(code, fight);

    systemEmitChat(code, "❗ A winner of the fight must be decided. Both sides selected different results. Please select again.");
    io.to(`fight:${code}`).emit("voteReset", { reason:"CONFLICT" });
    return res.json({ ok:true, concluded:false, reset:true });
  }

  res.json({ ok:true, concluded:false });
});

// sockets
io.on("connection", (socket)=>{
  socket.on("joinUserRoom", (userId)=>{ if(typeof userId==="number") socket.join(`user:${userId}`); });
  socket.on("joinFightRoom", (payload)=>{
    if(!payload || typeof payload.code!=="string" || typeof payload.userId!=="number") return;
    socket.data.code=payload.code;
    socket.data.userId=payload.userId;
    socket.join(`fight:${payload.code}`);
  });
  socket.on("chat", (payload)=>{
    const code=socket.data.code;
    const userId=socket.data.userId;
    if(!code || !userId) return;

    let fight=getFightByCode(code);
    if(!fight) return;

    fight = checkAcceptedTimeoutAndMaybeDraw(fight);
    if(fight.chat_locked) return;

    const side=participantSide(fight, userId);
    if(!side) return;

    const text=String(payload?.text||"").slice(0,500).trim();
    if(!text) return;

    const alias=fight.chat_aliases?.[String(userId)] || "Unknown";
    const msg={ at: nowIso(), alias, side, text };

    fight.chat_log=fight.chat_log||[];
    fight.chat_log.push(msg);
    if(fight.chat_log.length>300) fight.chat_log=fight.chat_log.slice(-300);
    saveFight(code, fight);

    io.to(`fight:${code}`).emit("chat", msg);
  });
});

server.listen(PORT, ()=>console.log(`Rise of Agon PvP Finder running on http://localhost:${PORT}`));
