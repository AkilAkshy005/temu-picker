# Temu Picker

Type a product. It finds Temu listings, checks web reviews, YouTube, Reddit/Trustpilot, and ranks them with Gemini.
Works in any browser and installs on a phone home screen. Free to run.

## 3 free keys
- `GEMINI_API_KEY` – aistudio.google.com/apikey
- `YOUTUBE_API_KEY` – console.cloud.google.com → enable "YouTube Data API v3" → Credentials → API key
- `TAVILY_API_KEY` – app.tavily.com (1,000 free credits/month, no card)

Each search uses 3 Tavily credits, so about 330 searches a month. Results are cached 6 hours.

## Run on laptop
    cp .dev.vars.example .dev.vars   # paste keys
    node dev-server.mjs              # http://localhost:8788
No keys = demo mode.

## Put online free (Cloudflare Pages)
GitHub → Cloudflare Pages → connect repo → build command and output folder empty.
Add the 3 keys under Settings → Variables and Secrets. On phone: open link → Add to Home screen.
