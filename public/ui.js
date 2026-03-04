const socket = io();
function playOneShot(src){ try{ const a=new Audio(src); a.play().catch(()=>{});}catch{} }

let OPEN_MATCH_CODE = null;

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, credentials: "include", ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
function el(html){ const d=document.createElement("div"); d.innerHTML=html.trim(); return d.firstChild; }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

let ME=null, chosenSize=1, myOpenFight=null;
let openedMatchCode=null;
let IS_ADMIN=false;
let notifyLoop=null, titleFlash=null, lastTitle=document.title;
let notifPage=1;

function playOnce(url){ try{ const a=new Audio(url); a.play().catch(()=>{}); }catch{} }

function startTitleFlash(text){ stopTitleFlash(); let on=false; titleFlash=setInterval(()=>{ document.title=on?text:lastTitle; on=!on; },800); }
function stopTitleFlash(){ if(titleFlash) clearInterval(titleFlash); titleFlash=null; document.title=lastTitle; }

function startNotifyLoop(){
  try{
    if (notifyLoop) return;
    notifyLoop = new Audio("/audio/notify.wav");
    notifyLoop.loop = false;
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

function closeMatchPanel(concluded=false){
  const panel=document.getElementById("matchPanel");
  const frame=document.getElementById("matchFrame");
  panel.classList.add("hidden");
  frame.src="about:blank";
  stopNotifyLoop();
  openedMatchCode = null;
  if(concluded){ setTimeout(()=>location.reload(), 250); }
}

function openMatchPanel(code){
  const panel=document.getElementById("matchPanel");
  const frame=document.getElementById("matchFrame");
  const url=`/match/${code}`;
  frame.src=url;
  panel.classList.remove("hidden");
  OPEN_MATCH_CODE = code;
  try{ refreshNotifs(); }catch{}
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
  const pager=document.getElementById('notifPager');
  if(pager) pager.innerHTML='';
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
            ${OPEN_MATCH_CODE===p.code?`<span class="tiny">Match open</span>`:`<button class="btn primary">Open match</button>`}
          </div>
        </div>
      `);
      const btn=item.querySelector("button");
      if(btn) btn.onclick=async()=>{
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

  if(pager){
    const tp = Number(data.totalPages||1);
    if(tp>1){
      for(let p=1;p<=tp;p++){
        const b=document.createElement('button');
        b.className='btn small';
        if(p===notifPage) b.classList.add('primary');
        b.textContent=String(p);
        b.onclick=async()=>{ notifPage=p; await refreshNotifs();
  await refreshAnnouncements();
  await refreshLeaderboard();
  await setupAdminTools();
  setupReport(); };
        pager.appendChild(b);
      }
    }
  }
}

socket.on("notification", async (notif)=>{
  if(notif?.type==="MATCH_READY"){
    startNotifyLoop();
    flashBrowserNotification("Rise of Agon PvP Finder","Match found!");
    playOneShot("/audio/notify.wav");
    if(notif?.payload?.code){
      openMatchPanel(notif.payload.code);
      stopNotifyLoop();
    }
  }
  if(notif?.type==="FIGHT_CONCLUDED"){
    const r = String(notif.payload?.result || "");
    if(r==="VICTORY") playOnce("/audio/df_narrator_victory.wav");
    if(r==="DEFEAT") playOnce("/audio/df_narrator_defeat.wav");
  }
  await refreshNotifs();
  await refreshAnnouncements();
  await refreshLeaderboard();
  await setupAdminTools();
  setupReport();
});

(async function init(){
  await loadMe();
  setupCreateFightUI();
  await loadMyOpenFight();
  await refreshOpenFights();
  await refreshNotifs();
  await refreshAnnouncements();
  await refreshLeaderboard();
  await setupAdminTools();
  setupReport();
  setInterval(refreshOpenFights, 5000);
  setInterval(refreshLeaderboard, 15000);
})();


async function refreshLeaderboard(){
  const box=document.getElementById("leaderboard");
  if(!box) return;
  const data=await api("/api/leaderboard").catch(()=>({users:[]}));
  const users=data.users||[];
  box.innerHTML="";
  if(!users.length){ box.innerHTML=`<div class="tiny">No data yet.</div>`; return; }
  for(let i=0;i<users.length;i++){
    const u=users[i];
    const row=el(`<div class="item"><div><div class="title">#${i+1} ${escapeHtml(u.username)}</div><div class="meta">Rating: ${u.rating}</div></div></div>`);
    box.appendChild(row);
  }
}

async function refreshAnnouncements(){
  const card=document.getElementById("annCard");
  const box=document.getElementById("adminMessages");
  if(!card || !box) return;
  const data=await api("/api/announcements").catch(()=>({items:[]}));
  const items=data.items||[];
  if(!items.length){
    card.classList.add("hidden");
    box.textContent="";
    return;
  }
  card.classList.remove("hidden");
  const latest = items[0];
  box.innerHTML = `<div class="annText">${escapeHtml(latest.text)}</div><div class="tiny">${new Date(latest.created_at).toLocaleString()}</div>`;
}

socket.on("announcement", async ()=>{ await refreshAnnouncements(); });
socket.on("announcementCleared", async ()=>{ await refreshAnnouncements(); });

async function setupAdminTools(){
  const adminBox=document.getElementById("adminTools");
  if(!adminBox) return;

  // Determine if I am admin
  const me = await api("/api/me").catch(()=>({authenticated:false}));
  if(!me.authenticated) return;

  const admin = await api("/api/admin/me").catch(()=>null);
  if(!admin || !admin.ok) return;

  adminBox.classList.remove("hidden");

  // hide/show admin tools
  const hideBtn=document.getElementById("hideAdminTools");
  const badge=document.getElementById("showAdminToolsBadge");
  const applyHidden=(hidden)=>{
    if(hidden){
      adminBox.classList.add("hidden");
      badge && badge.classList.remove("hidden");
      localStorage.setItem("adminToolsHidden","1");
    }else{
      adminBox.classList.remove("hidden");
      badge && badge.classList.add("hidden");
      localStorage.removeItem("adminToolsHidden");
    }
  };
  if(localStorage.getItem("adminToolsHidden")==="1") applyHidden(true);
  hideBtn && hideBtn.addEventListener("click", ()=>applyHidden(true));
  badge && badge.addEventListener("click", ()=>applyHidden(false));

  // Buttons / inputs
  const annText=document.getElementById("annText");
  const postAnn=document.getElementById("postAnn");
  const clearAnn=document.getElementById("clearAnnBtn");
  const delUser=document.getElementById("delUser");
  const delUserBtn=document.getElementById("delUserBtn");
  const banUser=document.getElementById("banUser");
  const banBtn=document.getElementById("banBtn");
  const resetUser=document.getElementById("resetUser");
  const resetRating=document.getElementById("resetRating");
  const resetBtn=document.getElementById("resetBtn");
  const delFightCode=document.getElementById("delFightCode");
  const delFightBtn=document.getElementById("delFightBtn");
  const resetAllBtn=document.getElementById("resetAllBtn");
  const wipeNotifsBtn=document.getElementById("wipeNotifsBtn");

  postAnn && postAnn.addEventListener("click", async ()=>{
    const text=(annText?.value||"").trim();
    if(!text) return alert("Enter a message");
    await api("/api/announcements",{method:"POST", body: JSON.stringify({text})});
    annText.value="";
  });

  clearAnn && clearAnn.addEventListener("click", async ()=>{
    await api("/api/admin/clear-announcements",{method:"POST", body:"{}"});
  });

  delUserBtn && delUserBtn.addEventListener("click", async ()=>{
    const u=(delUser?.value||"").trim();
    if(!u) return alert("Enter a username");
    await api("/api/admin/delete-user",{method:"POST", body: JSON.stringify({username:u})});
    delUser.value="";
  });

  banBtn && banBtn.addEventListener("click", async ()=>{
    const u=(banUser?.value||"").trim();
    if(!u) return alert("Enter a username");
    await api("/api/admin/ban-user",{method:"POST", body: JSON.stringify({username:u})});
    banUser.value="";
  });

  resetBtn && resetBtn.addEventListener("click", async ()=>{
    const u=(resetUser?.value||"").trim();
    const r=Number((resetRating?.value||"").trim());
    if(!u) return alert("Enter a username");
    if(!Number.isFinite(r)) return alert("Enter a numeric rating");
    await api("/api/admin/reset-rating",{method:"POST", body: JSON.stringify({username:u, rating:r})});
    resetUser.value="";
    resetRating.value="";
    await refreshLeaderboard();
  });

  delFightBtn && delFightBtn.addEventListener("click", async ()=>{
    const code=(delFightCode?.value||"").trim();
    if(!code) return alert("Enter a fight code");
    await api("/api/admin/delete-fight",{method:"POST", body: JSON.stringify({code})});
    delFightCode.value="";
    await refreshOpenFights();
  });

  resetAllBtn && resetAllBtn.addEventListener("click", async ()=>{
    if(!confirm("Reset ALL ratings to 1000?")) return;
    await api("/api/admin/reset-all-ratings",{method:"POST", body: JSON.stringify({rating:1000})});
    await refreshLeaderboard();
  });

  wipeNotifsBtn && wipeNotifsBtn.addEventListener("click", async ()=>{
    if(!confirm("Wipe notifications for ALL users?")) return;
    await api("/api/admin/wipe-notifications",{method:"POST", body:"{}"});
  });

  // Admin drawer
  const drawer=document.getElementById("fightListModal");
  const closeDrawer=document.getElementById("closeFightList");
  const list=document.getElementById("fightList");
  const pager=document.getElementById("matchPager");
  const reportList=document.getElementById("reportList");
  const bodyMatches=document.getElementById("drawerBodyMatches");
  const bodyReports=document.getElementById("drawerBodyReports");

  const openMatchesBtn=document.getElementById("openMatchesBtn");
  const openReportsBtn=document.getElementById("openReportsBtn");
  const clearAllMatchesBtn=document.getElementById("clearAllMatchesBtn");

  let matches=[];
  let page=1;
  const perPage=6;

  const setMode=(mode)=>{
    if(mode==="matches"){
      bodyMatches?.classList.remove("hidden");
      bodyReports?.classList.add("hidden");
    }else{
      bodyReports?.classList.remove("hidden");
      bodyMatches?.classList.add("hidden");
    }
  };

  async function loadMatches(){
    const data=await api("/api/admin/fights").catch(()=>({active:[], history:[]}));
    matches=[...(data.active||[]), ...(data.history||[])];
    matches.sort((a,b)=>{
      const ta=new Date(a.concluded_at||a.created_at||a.accepted_at||0).getTime();
      const tb=new Date(b.concluded_at||b.created_at||b.accepted_at||0).getTime();
      return tb-ta;
    });
  }

  function renderPager(){
    if(!pager) return;
    const total=Math.max(1, Math.ceil(matches.length/perPage));
    page=Math.min(page,total);
    pager.innerHTML="";
    if(total<=1) return;

    const add=(label, target, primary=false)=>{
      const b=el(`<button class="btn small ${primary?"primary":""}">${label}</button>`);
      b.addEventListener("click", ()=>{ page=target; renderMatches(); });
      pager.appendChild(b);
    };

    add("Prev", Math.max(1,page-1));
    let start=Math.max(1,page-3);
    let end=Math.min(total,start+6);
    start=Math.max(1,end-6);
    for(let p=start;p<=end;p++) add(String(p), p, p===page);
    add("Next", Math.min(total,page+1));
  }

  function renderMatches(){
    if(!list) return;
    const start=(page-1)*perPage;
    const items=matches.slice(start,start+perPage);
    list.innerHTML="";
    if(!items.length){
      list.innerHTML=`<div class="tiny">No matches found.</div>`;
    }else{
      for(const f of items){
        const status=f.status || f.result || "OPEN";
        const stamp=f.concluded_at || f.created_at || f.accepted_at;
        const when=stamp ? new Date(stamp).toLocaleString() : "";
        const item = el(`<div class="item">
          <div style="flex:1;">
            <div class="title">${escapeHtml(f.format || `${f.team_size}v${f.team_size}`)} <span class="tiny">(${escapeHtml(status)})</span></div>
            <div class="meta">Fight ID: <b>${escapeHtml(f.code)}</b> • ${escapeHtml(when)}</div>
            <div class="meta">Participants: ${escapeHtml([...(f.poster_usernames||[]),...(f.accepter_usernames||[])].join(", "))}</div>
            ${f.result?`<div class="meta">Result: ${escapeHtml(f.result)} • Winners: ${escapeHtml((f.winner_usernames||[]).join(", "))} (+${Math.abs(Number(f.rating_delta||0))}) • Losers: ${escapeHtml((f.loser_usernames||[]).join(", "))} (-${Math.abs(Number(f.rating_delta||0))})</div>`:""}
          </div>
          <button class="btn small primary">Open room</button>
        </div>`);
        item.querySelector("button").addEventListener("click", ()=>openMatchPanel(f.code));
        list.appendChild(item);
      }
    }
    renderPager();
  }

  async function loadReports(){
    const data=await api("/api/admin/reports").catch(()=>({reports:[]}));
    const reps=data.reports||[];
    reportList.innerHTML="";
    if(!reps.length){
      reportList.innerHTML=`<div class="tiny">No reports yet.</div>`;
      return;
    }
    for(const r of reps){
      const item = el(`<div class="item">
        <div style="flex:1;">
          <div class="title">${escapeHtml(r.username)}</div>
          <div class="meta">${escapeHtml(new Date(r.created_at).toLocaleString())}</div>
          <div style="margin-top:6px; white-space:pre-wrap;">${escapeHtml(r.message)}</div>
        </div>
      </div>`);
      reportList.appendChild(item);
    }
  }

  openMatchesBtn && openMatchesBtn.addEventListener("click", async ()=>{
    if(!drawer) return;
    setMode("matches");
    await loadMatches();
    page=1;
    renderMatches();
    drawer.classList.remove("hidden");
  });

  const clearReportsBtn=document.getElementById("clearReportsBtn");
  clearReportsBtn && clearReportsBtn.addEventListener("click", async ()=>{
    if(!confirm("Clear ALL player reports?")) return;
    await api("/api/admin/reports/clear",{method:"POST", body:"{}"});
    await loadReports();
  });

  openReportsBtn && openReportsBtn.addEventListener("click", async ()=>{
    if(!drawer) return;
    setMode("reports");
    await loadReports();
    drawer.classList.remove("hidden");
  });

  clearAllMatchesBtn && clearAllMatchesBtn.addEventListener("click", async ()=>{
    if(!confirm("Delete ALL matches (open + history + chat logs)?")) return;
    await api("/api/admin/matches/clear",{method:"POST", body:"{}"});
    // refresh panels
    try{ await refreshOpenFights(); }catch{}
    try{ await refreshLeaderboard(); }catch{}
    drawer?.classList.add("hidden");
  });

  closeDrawer && closeDrawer.addEventListener("click", ()=>drawer?.classList.add("hidden"));
}


function setupReport(){
  const btn=document.getElementById("reportBtn");
  const overlay=document.getElementById("reportOverlay");
  const close=document.getElementById("closeReport");
  const send=document.getElementById("sendReport");
  const msg=document.getElementById("reportMsg");
  const text=document.getElementById("reportText");
  if(!btn||!overlay||!close||!send||!msg||!text) return;

  const open=()=>{ overlay.classList.remove("hidden"); msg.textContent=""; setTimeout(()=>text.focus(), 50); };
  const hide=()=>{ overlay.classList.add("hidden"); };

  btn.onclick=open;
  close.onclick=hide;
  overlay.onclick=(e)=>{ if(e.target===overlay) hide(); };

  send.onclick=async()=>{
    const m=text.value.trim();
    if(!m){ msg.textContent="Please enter a message."; return; }
    try{
      await api("/api/report",{method:"POST", body: JSON.stringify({message:m})});
      msg.textContent="Sent. Thank you!";
      text.value="";
      setTimeout(hide, 600);
    }catch(e){
      msg.textContent="Failed to send. Please login first.";
    }
  };
}


window.addEventListener("message",(ev)=>{
  const d=ev.data;
  if(!d || typeof d!=="object") return;
  if(d.type==="CLOSE_MATCH"){
    try{
      const panel=document.getElementById("matchPanel");
      if(panel) panel.classList.add("hidden");
    }catch{}
  }
});
