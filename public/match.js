const socket = io();
let CONCLUDE_HANDLED=false;
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, credentials: "include", ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function addChatLine(who, whoClass, text, at){
  const log=document.getElementById("chatLog");
  const div=document.createElement("div");
  div.className="msg";
  div.innerHTML=`<div class="who ${whoClass}">${escapeHtml(who)} • ${new Date(at).toLocaleTimeString()}</div><div>${escapeHtml(text)}</div>`;
  log.appendChild(div);
  log.scrollTop=log.scrollHeight;
}
function addSystemLine(text){ addChatLine("Herald","sys",text,new Date().toISOString()); }
function getCode(){ const parts=location.pathname.split("/"); return String(parts[parts.length-1]||""); }
function playOnce(url){ try{ const a=new Audio(url); a.play().catch(()=>{}); }catch{} }

async function ensureBrowserNotificationPermission(){
  if(!("Notification" in window)) return false;
  if(Notification.permission==="granted") return true;
  if(Notification.permission==="denied") return false;
  const perm=await Notification.requestPermission().catch(()=> "denied");
  return perm==="granted";
}
async function flashBrowserNotification(title, body){
  const ok=await ensureBrowserNotificationPermission(); if(!ok) return;
  try{ new Notification(title,{body}); }catch{}
}
function formatRemaining(ms){
  ms=Math.max(0,ms);
  const s=Math.floor(ms/1000), m=Math.floor(s/60), r=s%60;
  return `${String(m).padStart(2,"0")}:${String(r).padStart(2,"0")}`;
}

let ME=null, FIGHT=null, hasVoted=false;
const code=getCode();
let timerIv=null, matchEndsAtMs=null;

async function loadMe(){
  const data=await api("/api/me").catch(()=>({authenticated:false}));
  if(!data.authenticated){ alert("Login required."); location.href="/"; return; }
  ME=data.user;
  socket.emit("joinUserRoom", ME.id);
  document.getElementById("meBox").innerHTML=`<div><strong>${escapeHtml(ME.username)}</strong></div><div class="tiny">Rating: ${ME.rating}</div>`;
}
function setChatLocked(locked){
  const input=document.getElementById("chatInput");
  const btn=document.getElementById("sendChat");
  const msg=document.getElementById("chatLockMsg");
  if(locked){ input.disabled=true; btn.disabled=true; msg.textContent="Chat is sealed. This match has concluded."; }
  else { input.disabled=false; btn.disabled=false; msg.textContent=""; }
}
function startTimer(){
  const el=document.getElementById("timer");
  if(timerIv) clearInterval(timerIv);
  timerIv=setInterval(async()=>{
    if(!matchEndsAtMs){ el.textContent="--:--"; return; }
    const ms=matchEndsAtMs - Date.now();
    el.textContent=formatRemaining(ms);
    if(ms<=0){ try{ await loadFight(); }catch{} }
  }, 500);
}
async function loadFight(){
  const resp=await api(`/api/fights/${code}`);
  FIGHT = resp.fight || resp;
  socket.emit("joinFightRoom", { code, userId: ME.id });
  document.getElementById("location").textContent=(FIGHT.location || FIGHT.meetup_location || "Pending…");
  setChatLocked(!!FIGHT.chat_locked);
  matchEndsAtMs = (FIGHT.match_expires_at || FIGHT.match_ends_at) ? Date.parse(FIGHT.match_expires_at || FIGHT.match_ends_at) : null;

  const winBtn=document.getElementById("voteWin");
  const loseBtn=document.getElementById("voteLose");
  if(Number(FIGHT.team_size)===1){ winBtn.textContent="I Won!"; loseBtn.textContent="I Lost"; }
  else { winBtn.textContent="We Won!"; loseBtn.textContent="We Lost"; }

  if(FIGHT.status==="CONCLUDED") await showConcluded();
}
async function loadChatHistory(){
  const h=await api(`/api/fights/${code}/history`);
  for(const m of (h.chat_log||[])){
    const whoClass=(m.side==="SYSTEM")?"sys":((m.side===FIGHT.my_side)?"green":"red");
    addChatLine(m.alias||"Unknown", whoClass, m.text, m.at);
  }
  setChatLocked(!!h.chat_locked);
}
async function showConcluded(){
  const msg=document.getElementById("winnerMsg");
  try{
    const details=await api(`/api/fights/${code}/reveal`);
    const posterTeamName=details.poster.team_name;
    const accepterTeamName=details.accepter.team_name;
    const posterUsers=details.poster.usernames.join(", ");
    const accepterUsers=details.accepter.usernames.join(", ");
    document.getElementById("matchSub").textContent =
      `${posterTeamName} (${posterUsers}) vs ${accepterTeamName} (${accepterUsers}) • Location: ${details.meetup_location}`;

    if(details.winner_team==="DRAW"){ msg.textContent="Concluded. Result: DRAW."; }
    else{
      msg.textContent="Concluded.";
      const myWin=(details.winner_team===FIGHT.my_side);
      playOnce(myWin?"/audio/df_narrator_victory.wav":"/audio/df_narrator_defeat.wav");
    }

    document.getElementById("voteWin").disabled=true;
    document.getElementById("voteLose").disabled=true;
    document.getElementById("extendBtn").disabled=true;
    setChatLocked(true);

    try{
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type:"MATCH_CONCLUDED", code }, "*");
      }
    }catch{}
  }catch{
    msg.textContent="Concluded.";
    setChatLocked(true);
    try{
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type:"MATCH_CONCLUDED", code }, "*");
      }
    }catch{}
  }
}

function setupChat(){
  const input=document.getElementById("chatInput");
  document.getElementById("sendChat").onclick=()=>{
    const text=input.value.trim();
    if(!text) return;
    socket.emit("chat",{text});
    input.value="";
    try{ input.focus(); }catch{}
  };
  input.addEventListener("keydown",(e)=>{ if(e.key==="Enter") document.getElementById("sendChat").click(); });
  socket.on("chat",(msg)=>{
    const whoClass=(msg.side==="SYSTEM")?"sys":((msg.side===FIGHT.my_side)?"green":"red");
    addChatLine(msg.alias, whoClass, msg.text, msg.at);
    if(msg.side && msg.side !== "SYSTEM" && msg.side !== FIGHT.my_side){
      playOnce("/audio/chat.wav");
    }
  });
}

function setupWinnerVoting(){
  const msg=document.getElementById("winnerMsg");
  const winBtn=document.getElementById("voteWin");
  const loseBtn=document.getElementById("voteLose");
  const card=document.getElementById("winnerCard");
  const setButtons=(on)=>{ winBtn.disabled=!on; loseBtn.disabled=!on; };

  async function vote(outcome){
    if(hasVoted) return;
    try{
      hasVoted=true; setButtons(false);
      msg.textContent="Waiting on opponent to confirm loss or victory…";
      const out=await api(`/api/fights/${code}/vote-winner`,{method:"POST", body: JSON.stringify({vote: outcome})});
      if(out.concluded){ msg.textContent="Agreement reached. Sealing the record…"; await loadFight(); }
      if(out.reset){ hasVoted=false; setButtons(true); msg.textContent="A winner must be decided. Select again."; }
    }catch(e){ hasVoted=false; setButtons(true); msg.textContent=e.message; }
  }

  winBtn.onclick=()=>vote("WIN");
  loseBtn.onclick=()=>vote("LOSS");


  socket.on("winnerUpdate", async (data)=>{
  try{
    if(!data) return;
    if(!data.concluded) return;
    if(CONCLUDE_HANDLED) return;
    CONCLUDE_HANDLED=true;

    const reveal = await api(`/api/fights/${code}/reveal`);
    const wt = String(reveal.winner_team||"DRAW").toUpperCase();
    let outcome="DRAW";
    if(wt!=="DRAW"){
      const mySide = String(reveal.my_side||"").toUpperCase();
      outcome = (wt===mySide) ? "VICTORY" : "DEFEAT";
    }
    const delta = Number(reveal.rating_delta||15);
    const signed = outcome==="VICTORY" ? +delta : (outcome==="DEFEAT" ? -delta : 0);

    const outcomeTxt = outcome==="VICTORY" ? "Victory" : (outcome==="DEFEAT"?"Defeat":"Draw");
    addSystemLine(`Result: ${outcomeTxt} (${signed>=0?'+':''}${signed} Rating)`);
    if(reveal.location) addSystemLine(`Location: ${reveal.location}`);
    if(Array.isArray(reveal.participants)){
      const ppl = reveal.participants.map(p=>`${p.username} (${p.rating})`).join(", ");
      addSystemLine(`Participants: ${ppl}`);
    }

    if(outcome==="VICTORY") playNarrator("VICTORY");
    if(outcome==="DEFEAT") playNarrator("DEFEAT");

    addSystemLine("Match concluded, closing in 5 seconds…");
    try{ chatInput.disabled=true; sendBtn.disabled=true; }catch{}
    startCloseCountdown();
  }catch(e){ console.error("[winnerUpdate]", e); }
});
      msg.textContent="A winner must be decided. Select again.";
      card.classList.add("nudge");
      setTimeout(()=>card.classList.remove("nudge"), 900);
      return;
    }
    if(data.concluded){
      try{
        const reveal = await api(`/api/fights/${code}/reveal`);
        const winnerSide = reveal.winner_team;
        if(winnerSide && winnerSide!=="DRAW"){
          const winnerName = winnerSide==="POSTER" ? (reveal.poster?.team_name||"Winner") : (reveal.accepter?.team_name||"Winner");
          const loserName  = winnerSide==="POSTER" ? (reveal.accepter?.team_name||"Loser") : (reveal.poster?.team_name||"Loser");
          addSystemLine(`Winner: ${winnerName}`);
          addSystemLine(`Loser: ${loserName}`);
          const myWin = (FIGHT.my_side===winnerSide);
          playNarrator(myWin ? "VICTORY" : "DEFEAT");
        } else {
          addSystemLine("Result: DRAW");
        }
      }catch(e){}
      addSystemLine("Match concluded, closing in 5 seconds...");
      try{ winBtn.disabled=true; loseBtn.disabled=true; chatInput.disabled=true; sendBtn.disabled=true; }catch{}
      startCloseCountdown();
      return;
    }
    // confirmation messages
    if(data.poster_confirm){
      const isMine = FIGHT.my_side==="POSTER";
      addSystemLine(isMine ? `Your team has confirmed a ${data.poster_confirm==="WIN"?"WIN":"LOSS"}.` : `The enemy team has confirmed a ${data.poster_confirm==="WIN"?"WIN":"LOSS"}.`);
    }
    if(data.accepter_confirm){
      const isMine = FIGHT.my_side==="ACCEPTER";
      addSystemLine(isMine ? `Your team has confirmed a ${data.accepter_confirm==="WIN"?"WIN":"LOSS"}.` : `The enemy team has confirmed a ${data.accepter_confirm==="WIN"?"WIN":"LOSS"}.`);
    }
    // nudge if opponent voted
    if((data.poster_confirm && FIGHT.my_side!=="POSTER") || (data.accepter_confirm && FIGHT.my_side!=="ACCEPTER")){
      if(!winBtn.disabled && !loseBtn.disabled){
        card.classList.add("nudge");
        flashBrowser();
        setTimeout(()=>card.classList.remove("nudge"), 900);
      }
    }
  });


  socket.on("voteReset", ()=>{ hasVoted=false; setButtons(true); msg.textContent="A winner must be decided. Select again."; });

  socket.on("teamConfirmed",(data)=>{
    if(!data?.side||!data?.outcome) return;
    const isMine=(data.side===FIGHT.my_side);
    const outcome=(data.outcome==="WIN")?"a WIN":"a LOSS";
    addSystemLine(isMine ? `Your team has confirmed ${outcome}.` : `The enemy team has confirmed ${outcome}.`);
  });

  socket.on("winnerVoteNudge",(data)=>{
    if(!data?.from_side) return;
    if(data.from_side !== FIGHT.my_side && !winBtn.disabled && !loseBtn.disabled){
      card.classList.add("nudge");
      flashBrowserNotification("Rise of Agon PvP Finder","Enemy reported result — confirm win/loss.");
      playOnce("/audio/notify.wav");
      setTimeout(()=>card.classList.remove("nudge"), 4500);
    }
  });

  socket.on("fightConcluded", async (data)=>{
    if(data?.code !== code) return;
    await loadFight();
    await showConcluded();
  });
}

function setupExtend(){
  const btn=document.getElementById("extendBtn");
  const msg=document.getElementById("extendMsg");
  btn.onclick=async()=>{
    try{
      btn.disabled=true;
      msg.textContent="Waiting for the other team to confirm extension…";
      const out=await api(`/api/fights/${code}/extend`,{method:"POST"});
      if(out.match_ends_at) matchEndsAtMs=Date.parse(out.match_ends_at);
    }catch(e){
      btn.disabled=false;
      msg.textContent=e.message;
    }
  };

  socket.on("extendRequested",(data)=>{
    if(!data?.side) return;
    const isMine=(data.side===FIGHT.my_side);
    addSystemLine(isMine ? "Your team requested a timer extension." : "The enemy team requested a timer extension.");
    if(!isMine){
      flashBrowserNotification("Rise of Agon PvP Finder","Enemy requested timer extension.");
      playOnce("/audio/notify.wav");
    }
  });

  socket.on("extended",(data)=>{
    msg.textContent="Extension granted.";
    btn.disabled=false;
    if(data?.match_ends_at) matchEndsAtMs=Date.parse(data.match_ends_at);
    if(data?.match_expires_at) matchEndsAtMs=Date.parse(data.match_expires_at);
  });
}

(async function init(){
  await loadMe();
  await loadFight();
  await loadChatHistory();
  startTimer();
  setupChat();
  try{ document.getElementById("chatInput")?.focus(); }catch{}
  setupWinnerVoting();
  setupExtend();
  setTimeout(()=>{ try{ document.getElementById('chatInput').focus(); }catch{} }, 150);
})();


function startCloseCountdown(){
  const banner=document.getElementById("concludeBanner");
  const n=document.getElementById("concludeCountdown");
  if(!banner||!n) return;
  banner.classList.remove("hidden");
  let t=5;
  n.textContent=String(t);
  const iv=setInterval(()=>{
    t-=1;
    n.textContent=String(t);
    if(t<=0){
      clearInterval(iv);
      try{ window.parent.postMessage({type:"CLOSE_MATCH", code}, "*"); }catch{}
    }
  },1000);
}


function playNarrator(result){
  try{
    const src = (result==="VICTORY") ? "/audio/df_narrator_victory.wav" : "/audio/df_narrator_defeat.wav";
    const a=new Audio(src);
    a.volume=1.0;
    a.play().catch(()=>{});
  }catch{}
}


document.addEventListener("DOMContentLoaded", ()=>{ init(); });


socket.on("forceCloseMatch", (p)=>{
  try{
    if(!p || p.code!==code) return;
    if(CONCLUDE_HANDLED) return;
    CONCLUDE_HANDLED=true;

    const outcome = String(p.outcome||"").toUpperCase();
    const delta = Number(p.rating_delta||0);

    const outcomeTxt = outcome==="VICTORY" ? "Victory" : "Defeat";
    addSystemLine(`Result: ${outcomeTxt} (${delta>=0?'+':''}${delta} Rating)`);
    if(p.location) addSystemLine(`Location: ${p.location}`);
    if(Array.isArray(p.participants)){
      const ppl = p.participants.map(x=>`${x.username} (${x.rating})`).join(", ");
      addSystemLine(`Participants: ${ppl}`);
    }

    playNarrator(outcome==="VICTORY" ? "VICTORY" : "DEFEAT");
    addSystemLine("Match concluded, closing in 5 seconds…");

    try{ chatInput.disabled=true; sendBtn.disabled=true; }catch{}
    startCloseCountdown();
  }catch(e){
    console.error("[forceCloseMatch handler]", e);
  }
});
