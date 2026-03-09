async function api(path, opts={}){
  const res = await fetch(path, { credentials:"include", headers:{ "Content-Type":"application/json", ...(opts.headers||{}) }, ...opts });
  const ct = res.headers.get("content-type") || "";
  let body = ct.includes("application/json") ? await res.json().catch(()=>({})) : await res.text().catch(()=>"");
  if(!res.ok) throw new Error((body && body.error) || body || "Request failed");
  return body;
}
function escapeHtml(s){ return String(s??"").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
(async()=>{
  const list=document.getElementById("historyList");
  try{
    const data = await api("/api/match-history");
    const matches = data.matches || [];
    if(!matches.length){ list.innerHTML = '<div class="tiny">No matches found.</div>'; return; }
    for(const m of matches){
      const parts=(m.participants||[]).map(p=>`${p.username} (${p.rating})`).join(", ");
      const when = m.concluded_at ? new Date(m.concluded_at).toLocaleString() : "";
      const outcomeTxt = m.outcome==="VICTORY" ? "Victory" : (m.outcome==="DEFEAT" ? "Defeat" : "Draw");
      const modeCls = String(m.match_mode||"LAWLESS").toUpperCase()==="LAWFUL" ? "modeLawful" : "modeLawless";
      const modeTxt = String(m.match_mode||"LAWLESS").toUpperCase()==="LAWFUL" ? "Lawful" : "Lawless";
      const div=document.createElement("div");
      div.className="item";
      div.innerHTML=`<div><div class="title">${escapeHtml(m.format || `${m.team_size}v${m.team_size}`)} - <span class="${modeCls}">${modeTxt}</span></div>
      <div class="meta"><b>Result:</b> ${outcomeTxt} (${m.rating_delta>=0?'+':''}${m.rating_delta} Rating)</div>
      <div class="meta"><b>Location:</b> ${escapeHtml(m.location||"")}</div>
      <div class="meta"><b>Participants:</b> ${escapeHtml(parts)}</div>
      <div class="meta">${when}</div></div>`;
      list.appendChild(div);
    }
  }catch(e){
    list.innerHTML = `<div class="tiny">${escapeHtml(e.message||"Failed to load history")}</div>`;
  }
})();
