# AniNexus — Anime Lookup API

A cinematic anime search app + API, deployable to Vercel in minutes.

## 🚀 Deploy to Vercel

### Option A — Vercel CLI (recommended)
```bash
npm install -g vercel
vercel login
vercel --prod
```

### Option B — GitHub + Vercel Dashboard
1. Push this folder to a GitHub repo
2. Go to [vercel.com/new](https://vercel.com/new)
3. Import the repo → Deploy (zero config needed)

---

## 📁 Project Structure

```
anime-nexus/
├── api/
│   └── anime.js        ← Serverless API route
├── public/
│   └── index.html      ← Cinematic frontend UI
├── vercel.json         ← Vercel config (30s timeout)
└── package.json
```

---

## 🔌 API Usage

### Endpoint
```
GET /api/anime?q=<search query>
```

### Example
```
GET /api/anime?q=fire+force
```

### Response
```json
{
  "success": true,
  "anime": {
    "id": 123,
    "slug": "fire-force",
    "name": "Fire Force",
    "url": "https://anime.nexus/series/123/fire-force"
  },
  "art": {
    "logo": "https://...",
    "poster": "https://..."
  },
  "total_episodes_found": 24,
  "episodes": [
    {
      "number": 1,
      "title": "Episode Title",
      "thumbnail": "https://..."
    }
  ]
}
```

### Error Response
```json
{
  "success": false,
  "error": "No anime found for: \"xyz\""
}
```

---

## ⚙️ Local Development

```bash
npm install
npx vercel dev
```

Then open [http://localhost:3000](http://localhost:3000)

---

Data sourced from [anime.nexus](https://anime.nexus).
