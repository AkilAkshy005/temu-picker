const $ = (id) => document.getElementById(id);
const STEPS = ["Finding Temu products", "Reading Google reviews", "Watching YouTube reviews", "Checking Reddit & Trustpilot", "Ranking by proof"];
const IDEAS = ["phone stand", "LED strip lights", "yoga mat", "wireless earbuds", "kitchen organizer"];

let timer;

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "href") { if (/^https?:\/\//i.test(v)) { n.href = v; n.target = "_blank"; n.rel = "noopener noreferrer"; } }
    else if (k === "src") { if (/^https?:\/\//i.test(v)) n.src = v; }
    else n[k] = v;
  }
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
}

function list(title, items) {
  if (!items?.length) return null;
  return el("div", {}, el("h3", { textContent: title }), el("ul", {}, ...items.map((t) => el("li", { textContent: t }))));
}

// On Android, open the Temu app if installed; otherwise fall back to the web page.
function temuAppLink(url) {
  try {
    const u = new URL(url);
    if (!/Android/i.test(navigator.userAgent) || !/(^|\.)temu\.com$/.test(u.hostname)) return null;
    return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.einnovation.temu;S.browser_fallback_url=${encodeURIComponent(url)};end`;
  } catch { return null; }
}

function openLink(url, label = "Open in Temu app", cls = "open") {
  const a = el("a", { class: cls, href: url, textContent: label });
  const app = temuAppLink(url);
  if (app) { a.href = app; a.removeAttribute("target"); }
  return a;
}

function card(p, i) {
  const top = el("div", { class: "top" });
  if (p.image) top.append(el("img", { class: "thumb", src: p.image, alt: "", loading: "lazy", referrerPolicy: "no-referrer" }));
  top.append(
    el("div", {}, el("h2", {}, el("span", { class: "rank", textContent: "#" + (i + 1) + " " }), p.name), p.price ? el("div", { class: "price", textContent: p.price }) : null),
    el("div", { class: "score" }, el("b", { textContent: p.score }), el("span", { textContent: "/100" }))
  );
  const meta = el("div", { class: "meta" },
    el("span", { class: "pill " + p.verdict, textContent: p.verdict }),
    el("span", { textContent: p.confidence + " confidence" }),
    el("span", { textContent: "· " + p.proof.length + " proof link" + (p.proof.length === 1 ? "" : "s") })
  );
  const pc = el("div", { class: "pc" }, list("Good", p.pros), list("Bad", p.cons));
  const proof = el("div", { class: "proof" }, ...p.proof.map((x) => el("a", { href: x.url, textContent: x.source + ": " + x.title })));
  return el("article", { class: "card" + (i === 0 ? " best" : "") }, i === 0 ? el("div", { class: "badge", textContent: "Best pick" }) : null, top, meta, el("p", { class: "why", textContent: p.why }), pc, proof,
    openLink(p.searchUrl, "Find it on Temu now (live stock)"),
    openLink(p.url, "Original listing (may be sold out)", "live"));
}

function setLoading(on) {
  $("loading").hidden = !on;
  $("go").disabled = on;
  clearInterval(timer);
  if (!on) return;
  const ul = $("steps");
  ul.replaceChildren(...STEPS.map((s) => el("li", { textContent: s })));
  let i = 0;
  const tick = () => { if (ul.children[i]) ul.children[i].classList.add("done"); i = Math.min(i + 1, STEPS.length - 1); };
  tick();
  timer = setInterval(tick, 1800);
}

async function search(q) {
  q = q.trim();
  if (q.length < 2) return;
  $("q").value = q;
  $("error").hidden = $("summary").hidden = $("banner").hidden = true;
  $("results").replaceChildren();
  $("sources").textContent = "";
  setLoading(true);
  try {
    const r = await fetch("/api/suggest", { signal: AbortSignal.timeout(110000), method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Something went wrong.");
    if (d.demo) { $("banner").textContent = "Demo mode: sample data. Add your API keys to get real results."; $("banner").hidden = false; }
    $("summary").replaceChildren(el("div", { textContent: d.summary || "" }), d.products?.length ? el("div", { class: "small", textContent: "Ranked best to worst by how much real review proof backs each product (web, YouTube, Reddit)." }) : null, d.buyTips?.length ? el("div", {}, el("b", { textContent: "How to pick the best one on Temu:" }), el("ul", { class: "tips" }, ...d.buyTips.map((t) => el("li", { textContent: t })))) : null, d.warnings?.length ? el("ul", {}, ...d.warnings.map((w) => el("li", { textContent: w }))) : null);
    $("summary").hidden = !d.summary;
    $("results").replaceChildren(...(d.products || []).map(card));
    if (d.liveSearchUrl) $("results").append(el("div", { class: "card" }, el("p", { class: "why", textContent: (d.products || []).length ? "Want more, or to check stock? Temu's own live search always shows what is available now." : "No product pages found. Search live on Temu instead." }), openLink(d.liveSearchUrl, "Search live on Temu")));
    const s = Object.entries(d.status || {}).map(([k, v]) => k + (v.ok ? " ✓" : " ✗")).join("  ·  ");
    $("sources").textContent = d.demo ? "" : "Sources: " + s;
    history.replaceState(null, "", "?q=" + encodeURIComponent(q));
  } catch (e) {
    $("error").textContent = e.message;
    $("error").hidden = false;
  } finally {
    setLoading(false);
  }
}

$("home").addEventListener("click", (e) => {
  e.preventDefault();
  $("q").value = "";
  for (const id of ["error", "summary", "banner", "loading"]) $(id).hidden = true;
  $("results").replaceChildren();
  $("sources").textContent = "";
  history.replaceState(null, "", "/");
  scrollTo({ top: 0, behavior: "smooth" });
});
$("form").addEventListener("submit", (e) => { e.preventDefault(); search($("q").value); });
$("chips").replaceChildren(...IDEAS.map((t) => el("button", { type: "button", textContent: t, onclick: () => search(t) })));
const start = new URLSearchParams(location.search).get("q");
if (start) search(start);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
