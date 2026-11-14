// POST /api/suggest  { query: "phone stand" }
// Finds Temu products, gathers reviews from the web, YouTube, Reddit/Trustpilot,
// then asks Gemini to rank them using ONLY that evidence.

const CACHE_SECONDS = 6 * 60 * 60;
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const clip = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
const isHttp = (u) => /^https?:\/\//i.test(u || "");

// ---------- Sources ----------

async function search(env, query, { domains, exclude, max = 8, images = false } = {}) {
  if (!env.TAVILY_API_KEY) throw new Error("Tavily key missing");
  const r = await fetch("https://api.tavily.com/search", {
    signal: AbortSignal.timeout(15000),
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.TAVILY_API_KEY}` },
    body: JSON.stringify({
      query,
      search_depth: "basic", // 1 credit per call
      max_results: max,
      include_images: images,
      ...(domains && { include_domains: domains }),
      ...(exclude && { exclude_domains: exclude }),
    }),
  });
  if (!r.ok) throw new Error(`Search ${r.status}`);
  const d = await r.json();
  return (d.results || []).map((i) => {
    const img = i.images?.[0];
    return {
      title: clip(i.title, 140),
      url: i.url,
      snippet: clip(i.content, 300),
      image: typeof img === "string" ? img : img?.url || null,
      site: (() => { try { return new URL(i.url).hostname.replace(/^www\./, ""); } catch { return ""; } })(),
    };
  });
}

async function youtube(env, q) {
  if (!env.YOUTUBE_API_KEY) throw new Error("YouTube key missing");
  const key = env.YOUTUBE_API_KEY;
  const s = await fetch(
    "https://www.googleapis.com/youtube/v3/search?" +
      new URLSearchParams({ part: "snippet", type: "video", maxResults: 5, q, key, relevanceLanguage: "en" }),
    { signal: AbortSignal.timeout(15000) }
  );
  if (!s.ok) throw new Error(`YouTube ${s.status}`);
  const videos = ((await s.json()).items || []).map((v) => ({
    id: v.id.videoId,
    title: clip(v.snippet.title, 120),
    channel: v.snippet.channelTitle,
    url: `https://www.youtube.com/watch?v=${v.id.videoId}`,
  }));
  // Top comments from the first 2 videos (what real viewers say).
  await Promise.all(
    videos.slice(0, 2).map(async (v) => {
      try {
        const c = await fetch(
          "https://www.googleapis.com/youtube/v3/commentThreads?" +
            new URLSearchParams({ part: "snippet", videoId: v.id, maxResults: 8, order: "relevance", textFormat: "plainText", key }),
          { signal: AbortSignal.timeout(10000) }
        );
        if (c.ok)
          v.comments = ((await c.json()).items || []).map((i) => clip(i.snippet.topLevelComment.snippet.textDisplay, 200));
      } catch {}
    })
  );
  return videos;
}

// Real product pages end in ...-g-601099....html. Pages ending in -s.html are old
// search-landing pages and often show "sold out", so we skip them.
const PRODUCT_URL = /temu\.com\/.*-g-\d{6,}\.html|goods_id=/i;
const searchUrl = (name) => "https://www.temu.com/au/search_result.html?search_key=" + encodeURIComponent(name);

// Force the Australian store: https://www.temu.com/au/... (replaces any other country prefix like /kg-en/)
function toAustralia(url) {
  try {
    const u = new URL(url);
    u.hostname = "www.temu.com";
    u.pathname = "/au/" + u.pathname.replace(/^\/(?:[a-z]{2}(?:-[a-z]{2,3})?)\//i, "").replace(/^\//, "");
    u.search = ""; u.hash = "";
    return u.toString();
  } catch { return url; }
}

async function temuProducts(env, q) {
  const runs = await Promise.allSettled([
    search(env, `${q} temu`, { domains: ["temu.com"], max: 20, images: true }),
    search(env, `${q} - Temu`, { domains: ["temu.com"], max: 20, images: true }),
    search(env, `${q} temu.com product`, { max: 20, exclude: ["reddit.com", "youtube.com", "facebook.com", "instagram.com", "tiktok.com"] }),
  ]);
  const all = runs.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (runs.every((r) => r.status === "rejected")) throw runs[0].reason;
  const seen = new Set();
  const uniq = all.map((x) => ({ ...x, url: toAustralia(x.url) })).filter((x) => !seen.has(x.url) && seen.add(x.url));
  return uniq.filter((x) => PRODUCT_URL.test(x.url)).slice(0, 15);
}

// ---------- Gemini ----------

async function gemini(env, prompt) {
  // Gemini is sometimes busy (503). Retry, then fall back to a lighter model.
  const models = [env.GEMINI_MODEL || "gemini-flash-latest", "gemini-flash-lite-latest"];
  let last = "";
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let r;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        signal: AbortSignal.timeout(35000),
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
        }),
      });
      } catch (e) { last = `${model} timed out or failed`; break; }
      if (r.ok) {
        const d = await r.json();
        const text = d.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
        try { return JSON.parse(text); } catch { last = "bad JSON"; continue; }
      }
      last = `Gemini ${r.status}: ${clip(await r.text(), 160)}`;
      if (![429, 500, 503].includes(r.status)) throw new Error(last);
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
  throw new Error(last);
}

function buildPrompt(q, evidence) {
  return `You help a shopper pick good Temu products. The shopper wants: "${q}".

Below is EVIDENCE, each item with an id. Ids starting with T are Temu product pages (candidates). W = web review articles, R = Reddit/Trustpilot, Y = YouTube videos (with top viewer comments).

Rules:
- Choose up to 6 candidates, ONLY from T items that are real product pages (skip category pages, blogs, search pages). Pick the CLOSEST matches to the request. If none match exactly, still return the closest ones, and say in "summary" that they are close matches, not exact. Never refuse with a long explanation; keep "summary" to two short sentences.
- Every candidate must match ALL key words in the request (gender, colour, material, size, use). A candidate that misses one (for example women's when the request says men) must be left out.
- Judge each using only the evidence. Never invent ratings, prices, or facts. If a price or rating is not in the evidence, use null.
- A product with no outside proof (no W/R/Y item that clearly relates) must get confidence "Low" and score under 55.
- Mention real problems people report (quality, safety, shipping, fake photos) in "cons".
- "proof" lists ids of W/R/Y items that support your judgment. Use only ids that exist.
- Be short and plain. Each pro/con max 12 words. "why" max 25 words.
- "searchTerms": 3-6 plain words to search Temu live and find this same kind of product (no brand, no filler).
- "buyTips": up to 3 short rules (max 14 words each) for picking the best listing in Temu's live results for this request, based on the evidence: what rating/reviews to look for, features to match, things to avoid.
- "warnings": general cautions for this product type (max 3), only if supported by evidence.

Return JSON exactly like:
{"summary":"one or two plain sentences","products":[{"id":"T1","name":"short name","price":null,"score":0-100,"verdict":"Buy|Maybe|Skip","confidence":"High|Medium|Low","why":"","pros":[],"cons":[],"searchTerms":"","proof":["W1"]}],"buyTips":[],"warnings":[]}

EVIDENCE:
${JSON.stringify(evidence)}`;
}

// ---------- Handler ----------

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }
  const q = clip(body?.query, 80);
  if (q.length < 2) return json({ error: "Type a product, like 'phone stand'." }, 400);

  if (!env.GEMINI_API_KEY) return json(demo(q));

  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request("https://cache.local/suggest-v6?q=" + encodeURIComponent(q.toLowerCase()));
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(hit.body, hit);
  }

  const status = {};
  const track = (name, p) =>
    p.then(
      (v) => ((status[name] = { ok: true, count: v.length }), v),
      (e) => ((status[name] = { ok: false, error: e.message }), [])
    );

  const [temu, web, community, yt] = await Promise.all([
    track("Temu", temuProducts(env, q)),
    track("Web", search(env, `${q} temu review worth it quality`, { exclude: ["temu.com", "reddit.com", "trustpilot.com", "youtube.com"] })),
    track("Reddit/Trustpilot", search(env, `${q} temu review`, { domains: ["reddit.com", "trustpilot.com"] })),
    track("YouTube", youtube(env, `${q} temu review`)),
  ]);

  const candidates = temu.filter((t) => /temu\.com/i.test(t.url)).map((t, i) => ({ ...t, id: "T" + (i + 1) }));
  if (!candidates.length) {
    return json({
      query: q, products: [], status, liveSearchUrl: searchUrl(q),
      summary: "No live Temu product pages found for that. Try the live Temu search below, or use different words.",
    });
  }
  const W = web.map((x, i) => ({ ...x, id: "W" + (i + 1) }));
  const R = community.map((x, i) => ({ ...x, id: "R" + (i + 1) }));
  const Y = yt.map((x, i) => ({ ...x, id: "Y" + (i + 1) }));
  const index = Object.fromEntries([...W, ...R, ...Y].map((e) => [e.id, e]));

  const evidence = {
    T: candidates.map(({ id, title, snippet }) => ({ id, title, snippet })),
    W: W.map(({ id, title, snippet, site }) => ({ id, site, title, snippet })),
    R: R.map(({ id, title, snippet, site }) => ({ id, site, title, snippet })),
    Y: Y.map(({ id, title, channel, comments }) => ({ id, channel, title, comments })),
  };

  let ai;
  try {
    ai = await gemini(env, buildPrompt(q, evidence));
  } catch (e) {
    return json({ error: "The AI step failed. " + e.message, status }, 502);
  }

  const byId = Object.fromEntries(candidates.map((c) => [c.id, c]));
  const products = (ai.products || [])
    .filter((p) => byId[p.id] && isHttp(byId[p.id].url))
    .map((p) => ({
      name: clip(p.name, 90) || byId[p.id].title,
      url: byId[p.id].url,
      searchUrl: searchUrl(clip(p.searchTerms, 60) || clip(p.name, 60) || q),
      image: isHttp(byId[p.id].image) ? byId[p.id].image : null,
      price: p.price ? clip(String(p.price), 20) : null,
      score: Math.max(0, Math.min(100, Math.round(Number(p.score) || 0))),
      verdict: ["Buy", "Maybe", "Skip"].includes(p.verdict) ? p.verdict : "Maybe",
      confidence: ["High", "Medium", "Low"].includes(p.confidence) ? p.confidence : "Low",
      why: clip(p.why, 200),
      pros: (p.pros || []).slice(0, 4).map((s) => clip(s, 90)),
      cons: (p.cons || []).slice(0, 4).map((s) => clip(s, 90)),
      proof: (p.proof || [])
        .filter((id) => index[id] && isHttp(index[id].url))
        .map((id) => ({
          source: id[0] === "Y" ? "YouTube" : id[0] === "R" ? index[id].site : "Web",
          title: index[id].title,
          url: index[id].url,
        })),
    }))
    .sort((a, b) => b.score - a.score || b.proof.length - a.proof.length);

  const result = {
    query: q,
    summary: clip(ai.summary, 300),
    buyTips: (ai.buyTips || []).slice(0, 3).map((t) => clip(t, 110)),
    warnings: (ai.warnings || []).slice(0, 3).map((s) => clip(s, 160)),
    products,
    liveSearchUrl: searchUrl(q),
    status,
  };

  const res = json(result);
  if (cache && products.length) {
    const copy = new Response(JSON.stringify(result), {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${CACHE_SECONDS}` },
    });
    await cache.put(cacheKey, copy);
  }
  return res;
}

// Shown when no Gemini key is set, so you can preview the design.
function demo(q) {
  const p = (name, score, verdict, confidence, why, pros, cons) => ({
    name, url: "https://www.temu.com", image: null, price: null, score, verdict, confidence, why, pros, cons,
    proof: [
      { source: "YouTube", title: "Sample review video", url: "https://www.youtube.com" },
      { source: "reddit.com", title: "Sample community thread", url: "https://www.reddit.com" },
    ],
  });
  return {
    demo: true,
    query: q,
    summary: "Demo data only. Add your keys to get real results.",
    warnings: ["These are sample cards, not real products."],
    status: { Temu: { ok: false }, Web: { ok: false }, "Reddit/Trustpilot": { ok: false }, YouTube: { ok: false } },
    products: [
      p(`${q} - Sample A`, 84, "Buy", "High", "Reviewers on three sites say it matches the photos.", ["Sturdy for the price", "Ships in a week"], ["Colour slightly different"]),
      p(`${q} - Sample B`, 63, "Maybe", "Medium", "Mixed opinions; fine for light use.", ["Cheap"], ["Wears out in months", "Thin material"]),
      p(`${q} - Sample C`, 38, "Skip", "Low", "No outside reviews found.", [], ["No proof of quality"]),
    ],
  };
}
