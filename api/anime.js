// api/anime.js — Vercel Serverless Function
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN,
});

// Global in-memory cache to bypass Redis on warm starts
let cachedCookieString = null;
let cachedCookieRaw = null;

async function getCookieString(forceRefresh = false) {
  if (!cachedCookieString || forceRefresh) {
    const cached = await redis.get('anime_nexus_cookies');
    if (!cached) throw new Error('No cookies in cache — refresh service may be down');
    
    cachedCookieRaw = typeof cached === 'string' ? cached : JSON.stringify(cached);
    const cookies = typeof cached === 'string' ? JSON.parse(cached) : cached;
    cachedCookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }
  return cachedCookieString;
}

// Triggers refresh and polls Redis instead of waiting a flat 10 seconds
async function triggerRefreshAndGetNewCookies() {
  try {
    await fetch(`${process.env.RAILWAY_URL}/refresh`, {
      method: 'POST',
      headers: { 'x-refresh-secret': process.env.REFRESH_SECRET }
    });

    const oldRaw = cachedCookieRaw;
    
    // Poll Redis every 500ms for up to 5 seconds to see if cookies updated
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      const cached = await redis.get('anime_nexus_cookies');
      if (cached) {
        const currentRaw = typeof cached === 'string' ? cached : JSON.stringify(cached);
        if (currentRaw !== oldRaw) {
          const cookies = typeof cached === 'string' ? JSON.parse(cached) : cached;
          cachedCookieRaw = currentRaw;
          cachedCookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
          return cachedCookieString;
        }
      }
    }
  } catch (err) {
    console.error('Failed to trigger refresh:', err.message);
  }

  // Fallback to whatever is currently in Redis if polling times out
  return getCookieString(true);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { q, ep } = req.query;
  if (!q || !q.trim()) {
    return res.status(400).json({ success: false, error: 'Missing search query. Use ?q=your+anime' });
  }

  try {
    const data = await scrapeAnime(q.trim(), ep);
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function scrapeAnime(searchQuery, targetEp) {
  const randomIP = `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

  // Fetches from in-memory cache on warm starts (0ms)
  let COOKIES = await getCookieString();

  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://anime.nexus/',
    'Origin': 'https://anime.nexus',
    'X-Forwarded-For': randomIP,
    'Cookie': COOKIES,
  };

  // STEP 1: Search
  const searchApiUrl = `https://api.anime.nexus/api/anime/shows?search=${encodeURIComponent(searchQuery)}&sortBy=name+asc&page=1&includes[]=poster`;
  const searchRes = await fetch(searchApiUrl, { headers: baseHeaders });
  if (!searchRes.ok) throw new Error(`Search API responded with ${searchRes.status}`);
  const searchData = await searchRes.json();

  let firstResult = searchData?.data?.[0];
  if (searchData?.data?.length > 0) {
    const exactMatch = searchData.data.find(
      (show) => show.name.toLowerCase() === searchQuery.toLowerCase()
    );
    if (exactMatch) firstResult = exactMatch;
  }
  if (!firstResult) return { success: false, error: `No anime found for: "${searchQuery}"` };

  const animeId = firstResult.id;
  const animeSlug = firstResult.slug;

  // ==========================================
  // IF A SPECIFIC EPISODE WAS REQUESTED
  // ==========================================
  if (targetEp) {
    const episodesApiUrl = `https://api.anime.nexus/api/anime/details/episodes?id=${animeId}&page=1&perPage=24&order=asc&fillers=true&recaps=true`;
    const episodesRes = await fetch(episodesApiUrl, { headers: baseHeaders });
    const episodesData = await episodesRes.json();

    const epMatch = (episodesData.data || []).find(e => String(e.number) === String(targetEp));
    if (!epMatch) return { success: false, error: `Episode ${targetEp} not found for this show.` };

    const episodePageUrl = `https://anime.nexus/series/${animeId}/${animeSlug}/episodes/${epMatch.number}`;
    const streamApiUrl = `https://api.anime.nexus/api/anime/details/episode/stream?id=${epMatch.id}&fillers=true&recaps=true`;

    const streamHeaders = {
      ...baseHeaders,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer': episodePageUrl,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
      'Connection': 'keep-alive',
    };

    let streamRes = await fetch(streamApiUrl, { headers: streamHeaders });

    // If 403, trigger cookie refresh, update local variables, and retry once
    if (streamRes.status === 403) {
      console.log('Got 403 — triggering emergency cookie refresh...');
      COOKIES = await triggerRefreshAndGetNewCookies();
      streamHeaders['Cookie'] = COOKIES;
      streamRes = await fetch(streamApiUrl, { headers: streamHeaders });
    }

    if (!streamRes.ok) {
      return { success: false, error: `Stream fetch failed. HTTP ${streamRes.status}` };
    }

    return await streamRes.json();
  }

  // ==========================================
  // NO EPISODE REQUESTED — Return show data
  // ==========================================
  const episodesApiUrl = `https://api.anime.nexus/api/anime/details/episodes?id=${animeId}&page=1&perPage=24&order=asc&fillers=true&recaps=true`;
  const targetUrl = `https://anime.nexus/series/${animeId}/${animeSlug}`;

  // Run the episode fetch and HTML scrape concurrently
  const [episodesData, html] = await Promise.all([
    fetch(episodesApiUrl, { headers: baseHeaders }).then(r => r.json()).catch(() => ({ data: [] })),
    fetch(targetUrl, { headers: { ...baseHeaders, Accept: 'text/html' } }).then(r => r.text()).catch(() => null)
  ]);

  let originalLogoPng = null;
  if (html) {
    try {
      const logoRegex = /logo:\$R\[\d+\]=\{resized:\$R\[\d+\]=\{large:"([^"]+)"/;
      const match = html.match(logoRegex);
      if (match && match[1]) {
        const cdnPath = match[1];
        const base64Marker = 'aHR0cHM6';
        const markerIndex = cdnPath.indexOf(base64Marker);
        if (markerIndex !== -1) {
          const base64String = cdnPath.substring(markerIndex).replace(/\.[a-z0-9]+$/i, '').replace(/\//g, '');
          originalLogoPng = Buffer.from(base64String, 'base64').toString('utf-8');
        }
      }
    } catch (_) {}
  }

  const episodes = (episodesData.data || []).map(ep => ({
    id: ep.id,
    number: ep.number,
    title: ep.title,
    thumbnail: ep.image?.resized?.['1920x1080']
      ? `https://anime.delivery${ep.image.resized['1920x1080']}`
      : null,
  }));

  return {
    success: true,
    anime: { id: animeId, slug: animeSlug, name: firstResult.name, url: targetUrl },
    art: {
      logo: originalLogoPng,
      poster: firstResult.poster?.resized?.['1560x2340']
        ? `https://anime.delivery${firstResult.poster.resized['1560x2340']}`
        : null,
    },
    total_episodes_found: episodes.length,
    episodes,
  };
}
