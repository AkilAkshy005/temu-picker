export async function onRequestPost({ request, env }) {
  if (request.headers.get("x-t") !== "e7db1d23a6c87263") return new Response("no", { status: 403 });
  const { urls, depth } = await request.json();
  const r = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + env.TAVILY_API_KEY },
    body: JSON.stringify({ urls, extract_depth: depth || "basic", format: "text" }),
  });
  const d = await r.json();
  return new Response(JSON.stringify({ status: r.status, results: (d.results || []).map((x) => ({ url: x.url, len: (x.raw_content || "").length, head: (x.raw_content || "").slice(0, 700) })), failed: d.failed_results, raw: r.ok ? undefined : d }), { headers: { "content-type": "application/json" } });
}
