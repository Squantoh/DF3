async function api(path, opts={}){
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type":"application/json", ...(opts.headers||{}) },
    ...opts
  });
  const ct = res.headers.get("content-type") || "";
  let body = ct.includes("application/json") ? await res.json().catch(()=>({})) : await res.text().catch(()=>"");
  if(!res.ok) throw new Error((body && body.error) || body || "Request failed");
  return body;
}
function escapeHtml(s){
  return String(s??"").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
(async()=>{
  const list=document.getElementById("historyList");
  try{
    const data = await api("/api/notifications");
    const items = (data.notifications || []).filter(n => n.type === "FIGHT_CONCLUDED");
    if(!items.length){
      list.innerHTML = '<div class="tiny">No matches found.</div>';
      return;
    }
    for(const n of items){
      const p = n.payload || {};
      const result = String(p.result || "Match Ended");
      const delta = Number(p.ratingDelta || p.rating_delta || 0);
      const deltaText = delta === 0 ? "(0 Rating)" : (delta > 0 ? `(+${delta} Rating)` : `(${delta} Rating)`);
      const loc = p.location || "";
      const participants = Array.isArray(p.participants) ? p.participants.join(", ") : "";
      const when = new Date(p.at || n.created_at).toLocaleString();
      const div=document.createElement("div");
      div.className="item";
      div.innerHTML = `
        <div>
          <div class="title">⚔️Match Concluded⚔️</div>
          <div class="meta">Result: ${escapeHtml(result)} ${escapeHtml(deltaText)}</div>
          <div class="meta">Location: ${escapeHtml(loc)}</div>
          <div class="meta">Participants: ${escapeHtml(participants)}</div>
          <div class="meta">${escapeHtml(when)}</div>
        </div>
      `;
      list.appendChild(div);
    }
  }catch(e){
    list.innerHTML = `<div class="tiny">${escapeHtml(e.message || "Failed to load history")}</div>`;
  }
})();
