const socket = io();
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, credentials: "include", ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
function el(html){ const d=document.createElement("div"); d.innerHTML=html.trim(); return d.firstChild; }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

let ME=null, chosenSize=1, myOpenFight=null;
let notifyLoop=null, titleFlash=null, lastTitle=document.title;

function playOnce(url){ try{ const a=new Audio(url); a.play().catch(()=>{}); }catch{} }

function startTitleFlash(text){ stopTitleFlash(); let on=false; titleFlash=setInterval(()=>{ document.title=on?text:lastTitle; on=!on; },800); }
function stopTitleFlash(){ if(titleFlash) clearInterval(titleFlash); titleFlash=null; document.title=lastTitle; }

function startNotifyLoop(){
  try{
    if (notifyLoop) return;
    notifyLoop = new Audio("/audio/notify.wav");
    notifyLoop.loop = true;
    notifyLoop.volume = 0.9;
    notifyLoop.play().catch(()=>{});
    document.body.classList.add("flash");
    startTitleFlash("MATCH FOUND!");
  }catch{}
}
function stopNotifyLoop(){
  try{ if(notifyLoop){ notifyLoop.pause(); notifyLoop.currentTime=0; } }catch{}
  notifyLoop=null; document.body.classList.remove("flash"); stopTitleFlash();
}

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

function renderMe(){
  const box=document.getElementById("meBox");
  if(!ME){
    box.innerHTML=`
      <div class="row" style="justify-content:flex-end; margin:0;">
        <button class="btn small" id="authToggle">Login or Register</button>
      </div>
      <div id="authInline" class="hidden"></div>
    `;
    const inline=document.getElementById("authInline");
    document.getElementById("authToggle").onclick=()=>{
      inline.classList.toggle("hidden");
      if(!inline.classList.contains("hidden")){
        inline.innerHTML=`
          <div class="row" style="justify-content:flex-end;">
            <input id="u" placeholder="Username" style="min-width:160px"/>
            <input id="p" placeholder="Password (min 6)" type="password" style="min-width:160px"/>
          </div>
          <div class="row" style="justify-content:flex-end;">
            <button class="btn primary" id="go">Enter</button>
          </div>
          <div class="tiny" id="authMsg"></div>
        `;
        document.getElementById("go").onclick=async()=>{
          const msg=document.getElementById("authMsg"); msg.textContent="";
          try{
            const username=document.getElementById("u").value.trim();
            const password=document.getElementById("p").value;
            await api("/api/auth",{method:"POST", body: JSON.stringify({username,password})});
            location.reload();
          }catch(e){ msg.textContent=e.message; }
        };
      }
    };
    return;
  }

  box.innerHTML=`
    <div><strong>${escapeHtml(ME.username)}</strong></div>
    <div class="row" style="margin:6px 0; justify-content:flex-end; gap:6px;">
      <button class="btn small" id="editTeam" title="Edit team name">✎</button>
      <div class="tiny" style="text-align:right;">
        <div><strong>Team Name:</strong> <span id="teamNameText">${escapeHtml(ME.team_name || ("Team of " + ME.username))}</span></div>
      </div>
    </div>
    <div class="tiny">Rating: ${ME.rating}</div>
    <div class="row" style="justify-content:flex-end;">
      <button class="btn small" id="logoutBtn">Logout</button>
    </div>
  `;
  document.getElementById("logoutBtn").onclick=async()=>{ await api("/api/logout",{method:"POST"}); location.reload(); };
  document.getElementById("editTeam").onclick=async()=>{
    const next=prompt("Set team name (shown after matches conclude):", ME.team_name || "");
    if(!next) return;
    try{
      const out=await api("/api/me/team-name",{method:"POST", body: JSON.stringify({team_name: next})});
      ME.team_name=out.team_name;
      document.getElementById("teamNameText").textContent=ME.team_name;
    }catch(e){ alert(e.message); }
  };
}

async function loadMe(){
  const data=await api("/api/me").catch(()=>({authenticated:false}));
  if(data.authenticated){ ME=data.user; socket.emit("joinUserRoom", ME.id); }
  renderMe();
}
async function loadMyOpenFight(){
  if(!ME){ myOpenFight=null; return; }
  const out=await api("/api/fights/mine-open").catch(()=>({has_open:false}));
  myOpenFight=out.has_open ? out.fight : null;
  const card=document.getElementById("createCard");
  if(myOpenFight) card.classList.add("hidden");
  else card.classList.remove("hidden");
}

function setupCreateFightUI(){
  const chosenMode=document.getElementById("chosenMode");
  const teammatesRow=document.getElementById("teammatesRow");
  const needCount=document.getElementById("needCount");
  const createBtn=document.getElementById("createFightBtn");
  const createMsg=document.getElementById("createMsg");

  function applyMode(n){
    chosenSize=n;
    chosenMode.textContent=`Mode: ${n}v${n}`;
    document.querySelectorAll(".selectBtn").forEach(b=>b.classList.remove("selected"));
    const btn=document.querySelector(`.selectBtn[data-size="${n}"]`);
    if(btn) btn.classList.add("selected");
    if(n>1){ teammatesRow.style.display=""; needCount.textContent=String(n-1); }
    else{ teammatesRow.style.display="none"; needCount.textContent="0"; document.getElementById("teammates").value=""; }
  }
  applyMode(1);
  document.querySelectorAll(".selectBtn").forEach(b=>{ b.onclick=()=>applyMode(Number(b.dataset.size)); });

  const customRow=document.getElementById("customRow");
  document.getElementById("customToggle").onclick=()=>{ customRow.classList.toggle("hidden"); document.getElementById("customSize").focus(); };
  document.getElementById("customSize").addEventListener("input",(e)=>{
    const n=Number(e.target.value); if(!Number.isFinite(n)||n<1||n>50) return; applyMode(n);
  });

  createBtn.onclick=async()=>{
    if(!ME){ createMsg.textContent="Login first."; return; }
    try{
      let teammateUsernames=[];
      if(chosenSize>1){
        teammateUsernames=document.getElementById("teammates").value.split(",").map(s=>s.trim()).filter(Boolean);
      }
      await api("/api/fights/create",{method:"POST", body: JSON.stringify({teamSize: chosenSize, teammateUsernames})});
      createMsg.textContent="Listed.";
      await loadMyOpenFight();
      await refreshOpenFights();
    }catch(e){ createMsg.textContent=e.message; }
  };
}

function closeMatchPanel(){
  const panel=document.getElementById("matchPanel");
  const frame=document.getElementById("matchFrame");
  panel.classList.add("hidden");
  frame.src="about:blank";
  stopNotifyLoop();
}

function openMatchPanel(code){
  const panel=document.getElementById("matchPanel");
  const frame=document.getElementById("matchFrame");
  const url=`/match/${code}`;
  frame.src=url;
  panel.classList.remove("hidden");
  stopNotifyLoop();
  flashBrowserNotification("Rise of Agon PvP Finder", "Match opened.");
  document.getElementById("closePanelBtn").onclick=closeMatchPanel;
  document.getElementById("popOutBtn").onclick=()=>window.open(url,"_blank");
}

window.addEventListener("message", (ev)=>{
  const data = ev.data || {};
  if(data.type === "MATCH_CONCLUDED"){ closeMatchPanel(); }
});

async function refreshOpenFights(){
  const box=document.getElementById("openFights");
  const data=await api("/api/fights/open").catch(()=>({fights:[]}));
  const fights=data.fights || [];
  box.innerHTML="";
  if(!fights.length){
    box.appendChild(el(`<div class="tiny">No players currently matching.</div>`));
    return;
  }

  for(const f of fights){
    const expMs=Date.parse(f.open_expires_at);
    const item=el(`
      <div class="item">
        <div>
          <div class="title">${f.team_size}v${f.team_size}</div>
          <div class="meta"><span class="whoLine"></span></div>
          <div class="meta">Expires in: <span class="ttl">--:--</span></div>
        </div>
        <div class="row actions" style="margin:0;"></div>
      </div>
    `);

    const whoLine = item.querySelector(".whoLine");
    if (f.is_participant && Array.isArray(f.creator_names) && f.creator_names.length){
      whoLine.textContent = f.creator_names.join(" + ");
    } else {
      whoLine.textContent = "Anonymous";
    }

    const ttl=item.querySelector(".ttl");
    const tick=()=>ttl.textContent=formatRemaining(expMs - Date.now());
    tick(); setInterval(tick, 1000);

    const actions=item.querySelector(".actions");
    if(f.is_mine){
      const repost=el(`<button class="btn primary">Repost</button>`);
      const remove=el(`<button class="btn">Remove</button>`);
      repost.onclick=async()=>{ try{ await api(`/api/fights/${f.code}/repost`,{method:"POST"}); await refreshOpenFights(); await loadMyOpenFight(); }catch(e){ alert(e.message); } };
      remove.onclick=async()=>{ if(!confirm("Remove your posted fight?")) return;
        try{ await api(`/api/fights/${f.code}`,{method:"DELETE"}); await refreshOpenFights(); await loadMyOpenFight(); }catch(e){ alert(e.message); }
      };
      actions.appendChild(repost); actions.appendChild(remove);
    } else if (f.is_participant) {
      actions.appendChild(el(`<div class="tiny">Your fight</div>`));
    } else {
      const accept=el(`<button class="btn primary">Accept</button>`);
      accept.onclick=async()=>{
        if(!ME){ alert("Login to accept fights."); return; }
        try{
          let teamUsernames=[];
          if(f.team_size>1){
            const raw=prompt(`Enter ${f.team_size-1} teammate usernames (comma-separated, do NOT include you):`);
            if(!raw) return;
            teamUsernames=raw.split(",").map(s=>s.trim()).filter(Boolean);
          }
          const out=await api(`/api/fights/${f.code}/accept`,{method:"POST", body: JSON.stringify({teammateUsernames: teamUsernames})});
          openMatchPanel(out.code);
          await refreshOpenFights();
        }catch(e){ alert(e.message); }
      };
      actions.appendChild(accept);
    }
    box.appendChild(item);
  }
}

async function refreshNotifs(){
  const box=document.getElementById("notifs");
  if(!ME){ box.innerHTML=`<div class="tiny">Login to receive notifications.</div>`; return; }
  const data=await api("/api/notifications").catch(()=>({notifications:[]}));
  const notifs=data.notifications || [];
  box.innerHTML="";
  if(!notifs.length){ box.innerHTML=`<div class="tiny">No notifications yet.</div>`; return; }

  for(const n of notifs){
    const t=n.type, p=n.payload||{};
    const time=new Date(n.created_at).toLocaleString();

    if(t==="MATCH_READY"){
      const item=el(`
        <div class="item">
          <div>
            <div class="title">Match found: ${p.team_size}v${p.team_size}</div>
            <div class="meta">Location: ${escapeHtml(p.meetup_location||"")}</div>
            <div class="meta">${time}</div>
          </div>
          <div class="row" style="margin:0;">
            <button class="btn primary">Open match</button>
          </div>
        </div>
      `);
      item.querySelector("button").onclick=async()=>{
        await api(`/api/notifications/${n.id}/read`,{method:"POST"}).catch(()=>{});
        openMatchPanel(p.code);
      };
      box.appendChild(item);
      continue;
    }

    if(t==="FIGHT_CONCLUDED"){
      const delta=Number(p.rating_delta||0);
      const deltaText = delta === 0 ? "(0 Rating)" : (delta > 0 ? `(+${delta} Rating)` : `(${delta} Rating)`);
      const result=String(p.result||"DRAW");
      const loc=escapeHtml(p.location||"");
      const participants=escapeHtml((p.participants||[]).join(", "));
      const when=new Date(p.at||n.created_at).toLocaleString();

      box.appendChild(el(`
        <div class="item">
          <div>
            <div class="title">⚔️Match Concluded⚔️</div>
            <div class="meta">Result: ${escapeHtml(result)} ${escapeHtml(deltaText)}</div>
            <div class="meta">Location: ${loc}</div>
            <div class="meta">Participants: ${participants}</div>
            <div class="meta">${escapeHtml(when)}</div>
          </div>
        </div>
      `));
      continue;
    }

    box.appendChild(el(`
      <div class="item">
        <div>
          <div class="title">${escapeHtml(t)}</div>
          <div class="meta">${escapeHtml(JSON.stringify(p))}</div>
          <div class="meta">${time}</div>
        </div>
      </div>
    `));
  }
}

socket.on("notification", async (notif)=>{
  if(notif?.type==="MATCH_READY"){
    startNotifyLoop();
    flashBrowserNotification("Rise of Agon PvP Finder","Match found! Open it to stop the alarm.");
  }
  if(notif?.type==="FIGHT_CONCLUDED"){
    const r = String(notif.payload?.result || "");
    if(r==="VICTORY") playOnce("/audio/df_narrator_victory.wav");
    if(r==="DEFEAT") playOnce("/audio/df_narrator_defeat.wav");
  }
  await refreshNotifs();
});

(async function init(){
  await loadMe();
  setupCreateFightUI();
  await loadMyOpenFight();
  await refreshOpenFights();
  await refreshNotifs();
  setInterval(refreshOpenFights, 5000);
})();
