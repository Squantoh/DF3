const socket = io();
const code = String(location.pathname.split("/").pop() || "");

let FIGHT = null;
let matchEndsAtMs = null;
let timerInterval = null;
let hasVoted = false;
let closeCountdown = null;
let concludeHandled = false;

const locationEl = document.getElementById("location");
const timerEl = document.getElementById("timer");
const extendBtn = document.getElementById("extendBtn");
const extendMsg = document.getElementById("extendMsg");
const winnerMsg = document.getElementById("winnerMsg");
const voteWinBtn = document.getElementById("voteWin");
const voteLoseBtn = document.getElementById("voteLose");
const chatLog = document.getElementById("chatLog");
const chatInput = document.getElementById("chatInput");
const sendChatBtn = document.getElementById("sendChat");
const chatLockMsg = document.getElementById("chatLockMsg");
const matchSub = document.getElementById("matchSub");
const concludeBanner = document.getElementById("concludeBanner");

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts
  });
  const ct = res.headers.get("content-type") || "";
  let body;
  if (ct.includes("application/json")) {
    body = await res.json().catch(() => ({}));
  } else {
    body = await res.text().catch(() => "");
  }
  if (!res.ok) {
    const msg = typeof body === "string" ? body : (body.error || "Request failed");
    throw new Error(msg || "Request failed");
  }
  return body;
}

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function addChatLine(who, whoClass, text, at){
  const div = document.createElement("div");
  div.className = "msg";
  div.innerHTML = `<div class="who ${whoClass}">${escapeHtml(who)} • ${new Date(at || Date.now()).toLocaleTimeString()}</div><div>${escapeHtml(text)}</div>`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addSystemLine(text){
  addChatLine("Herald", "sys", text, new Date().toISOString());
}

function playNarrator(kind){
  try{
    const src = kind === "VICTORY" ? "/audio/df_narrator_victory.wav" : "/audio/df_narrator_defeat.wav";
    const a = new Audio(src);
    a.play().catch(()=>{});
  }catch{}
}

function playChatSound(){
  try{
    const a = new Audio("/audio/chat.wav");
    a.play().catch(()=>{});
  }catch{}
}

function setChatLocked(locked){
  chatInput.disabled = !!locked;
  sendChatBtn.disabled = !!locked;
  chatLockMsg.textContent = locked ? "Chat is locked because the match has concluded." : "";
}

function renderTimer(){
  if (!matchEndsAtMs) {
    timerEl.textContent = "--:--";
    return;
  }
  const ms = Math.max(0, matchEndsAtMs - Date.now());
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  timerEl.textContent = `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function startTimer(){
  if (timerInterval) clearInterval(timerInterval);
  renderTimer();
  timerInterval = setInterval(renderTimer, 1000);
}

function startCloseCountdown(){
  if (closeCountdown) clearInterval(closeCountdown);
  let secs = 5;
  concludeBanner.textContent = `Match concluded, closing in ${secs} seconds…`;
  concludeBanner.classList.remove("hidden");
  closeCountdown = setInterval(()=>{
    secs -= 1;
    concludeBanner.textContent = `Match concluded, closing in ${secs} seconds…`;
    if (secs <= 0) {
      clearInterval(closeCountdown);
      window.parent.postMessage({ type: "CLOSE_MATCH", code }, "*");
    }
  }, 1000);
}

async function loadFight(){
  const resp = await api(`/api/fights/${code}`);
  FIGHT = resp.fight || resp;

  locationEl.textContent = FIGHT.location || "Pending…";
  matchEndsAtMs = FIGHT.match_expires_at ? Date.parse(FIGHT.match_expires_at) : null;
  startTimer();

  if (Number(FIGHT.team_size || 1) === 1) {
    voteWinBtn.textContent = "I Won!";
    voteLoseBtn.textContent = "I Lost";
  } else {
    voteWinBtn.textContent = "We Won!";
    voteLoseBtn.textContent = "We Lost";
  }

  if (FIGHT.status === "CONCLUDED" || FIGHT.status === "ARCHIVED") {
    await showConcluded();
  }
}

async function loadChatHistory(){
  const h = await api(`/api/fights/${code}/history`);
  chatLog.innerHTML = "";
  for (const m of (h.chat_log || [])) {
    const whoClass = (m.side === "SYSTEM") ? "sys" : ((m.side === FIGHT?.my_side) ? "green" : "red");
    addChatLine(m.alias || "Unknown", whoClass, m.text, m.at);
  }
  setChatLocked(!!h.chat_locked);
}

async function showConcluded(){
  try{
    const details = await api(`/api/fights/${code}/reveal`);
    const posterTeamName = details.poster?.team_name || "Poster Team";
    const accepterTeamName = details.accepter?.team_name || "Accepter Team";
    const posterUsers = (details.poster?.usernames || []).join(", ");
    const accepterUsers = (details.accepter?.usernames || []).join(", ");
    matchSub.textContent = `${posterTeamName} (${posterUsers}) vs ${accepterTeamName} (${accepterUsers}) • Location: ${details.meetup_location || ""}`;
  }catch{}
  setChatLocked(true);
}

async function sendChat(){
  const text = chatInput.value.trim();
  if (!text) return;
  try{
    socket.emit("chat", { text });
    chatInput.value = "";
  }catch(e){
    chatLockMsg.textContent = e.message || "Chat failed";
  }
}

async function vote(outcome){
  if (hasVoted) return;
  try{
    hasVoted = true;
    voteWinBtn.disabled = true;
    voteLoseBtn.disabled = true;
    winnerMsg.textContent = "Waiting on opponent to confirm loss or victory…";
    const out = await api(`/api/fights/${code}/vote-winner`, {
      method: "POST",
      body: JSON.stringify({ vote: outcome })
    });

    if (out.conflict) {
      hasVoted = false;
      voteWinBtn.disabled = false;
      voteLoseBtn.disabled = false;
      winnerMsg.textContent = "A winner must be decided. Select again.";
    }
  }catch(e){
    hasVoted = false;
    voteWinBtn.disabled = false;
    voteLoseBtn.disabled = false;
    winnerMsg.textContent = e.message || "Request failed";
  }
}

async function extendMatch(){
  try{
    extendBtn.disabled = true;
    extendMsg.textContent = "Waiting for other team to confirm extension…";
    const out = await api(`/api/fights/${code}/extend`, { method: "POST", body: "{}" });
    if (out.match_ends_at) {
      matchEndsAtMs = Date.parse(out.match_ends_at);
      startTimer();
      extendMsg.textContent = "Timer extended.";
    } else if (out.waiting) {
      extendMsg.textContent = "Waiting for other team to confirm extension…";
    } else if (out.capped) {
      extendMsg.textContent = "Extension cap reached.";
    } else {
      extendMsg.textContent = "Extension requested.";
    }
  }catch(e){
    extendMsg.textContent = e.message || "Match not active";
  }finally{
    setTimeout(()=>{ extendBtn.disabled = false; }, 800);
  }
}

function wireUI(){
  voteWinBtn.onclick = ()=>vote("WIN");
  voteLoseBtn.onclick = ()=>vote("LOSS");
  extendBtn.onclick = extendMatch;
  sendChatBtn.onclick = sendChat;
  chatInput.addEventListener("keydown", (e)=>{
    if (e.key === "Enter") sendChat();
  });
}

function wireSocket(){
  socket.emit("joinFightRoom", { code });
  socket.emit("joinMatch", code);

  socket.on("chat", (msg)=>{
    const whoClass = (msg.side === "SYSTEM") ? "sys" : ((msg.side === FIGHT?.my_side) ? "green" : "red");
    addChatLine(msg.alias || "Unknown", whoClass, msg.text, msg.at);
    if (msg.side && msg.side !== "SYSTEM" && msg.side !== FIGHT?.my_side) {
      playChatSound();
    }
  });

  socket.on("extended", (data)=>{
    if (data?.match_ends_at) {
      matchEndsAtMs = Date.parse(data.match_ends_at);
      startTimer();
      extendMsg.textContent = "Timer extended.";
    }
  });

  socket.on("winnerUpdate", (data)=>{
    if (!data) return;
    if (data.conflict) {
      hasVoted = false;
      voteWinBtn.disabled = false;
      voteLoseBtn.disabled = false;
      winnerMsg.textContent = "A winner must be decided. Select again.";
    }
  });

  socket.on("forceCloseMatch", (p)=>{
    try{
      if (!p || p.code !== code) return;
      if (concludeHandled) return;
      concludeHandled = true;

      const outcome = String(p.outcome || "DRAW").toUpperCase();
      const delta = Number(p.rating_delta || 0);
      const outcomeTxt = outcome === "VICTORY" ? "Victory" : (outcome === "DEFEAT" ? "Defeat" : "Draw");

      addSystemLine(`Result: ${outcomeTxt} (${delta >= 0 ? "+" : ""}${delta} Rating)`);
      if (p.location) addSystemLine(`Location: ${p.location}`);
      if (Array.isArray(p.participants)) {
        const ppl = p.participants.map(x => `${x.username} (${x.rating})`).join(", ");
        addSystemLine(`Participants: ${ppl}`);
      }

      if (outcome === "VICTORY") playNarrator("VICTORY");
      if (outcome === "DEFEAT") playNarrator("DEFEAT");

      addSystemLine("Match concluded, closing in 5 seconds…");
      setChatLocked(true);
      winnerMsg.textContent = "Match concluded.";
      startCloseCountdown();
    }catch(e){
      console.error("[forceCloseMatch]", e);
    }
  });
}

window.addEventListener("DOMContentLoaded", async ()=>{
  wireUI();
  wireSocket();
  try{
    await loadFight();
    await loadChatHistory();
  }catch(e){
    matchSub.textContent = e.message || "Failed to load match";
    locationEl.textContent = "Loading…";
    timerEl.textContent = "--:--";
  }
});
