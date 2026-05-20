// api/anime.js — Vercel Serverless Function

export default async function handler(req, res) {
  // CORS headers
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
  // Ultra-realistic browser headers to bypass 403 Forbidden blocks
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://anime.nexus',
    'Referer': 'https://anime.nexus/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'Connection': 'keep-alive'
  };

  // STEP 1: Search for the anime show
  const searchApiUrl = `https://api.anime.nexus/api/anime/shows?search=${encodeURIComponent(searchQuery)}&sortBy=name+asc&page=1&includes[]=poster`;
  const searchRes = await fetch(searchApiUrl, { headers });
  if (!searchRes.ok) throw new Error(`Search API responded with ${searchRes.status}`);
  const searchData = await searchRes.json();
  
  let firstResult = searchData?.data?.[0];

  // Try to find an exact title match first
  if (searchData?.data?.length > 0) {
    const exactMatch = searchData.data.find(
      (show) => show.name.toLowerCase() === searchQuery.toLowerCase()
    );
    if (exactMatch) firstResult = exactMatch;
  }

  if (!firstResult) {
    return { success: false, error: `No anime found for: "${searchQuery}"` };
  }

  const animeId = firstResult.id;
  const animeSlug = firstResult.slug;

  // STEP 2: Fetch episodes list to get the exact ID for the episode
  const episodesApiUrl = `https://api.anime.nexus/api/anime/details/episodes?id=${animeId}&page=1&perPage=24&order=asc&fillers=true&recaps=true`;
  const episodesRes = await fetch(episodesApiUrl, { headers });
  const episodesData = await episodesRes.json();

  // ==========================================
  // IF A SPECIFIC EPISODE WAS REQUESTED
  // ==========================================
  if (targetEp) {
    const epMatch = (episodesData.data || []).find(e => String(e.number) === String(targetEp));

    if (!epMatch) {
      return { success: false, error: `Episode ${targetEp} not found for this show.` };
    }

    // Pass the EXACT URL the user would be on as the Referer
    const exactReferer = `https://anime.nexus/series/${animeId}/${animeSlug}`;
    
    // Fetch the stream data using the correct Episode UUID
    const streamApiUrl = `https://api.anime.nexus/api/anime/details/episode/stream?id=${epMatch.id}&fillers=true&recaps=true`;
    
    const streamRes = await fetch(streamApiUrl, { 
      headers: {
        ...headers,
        'Referer': exactReferer
      } 
    });

    if (!streamRes.ok) {
      return { success: false, error: `Stream API blocked the request. HTTP ${streamRes.status}` };
    }

    const streamJson = await streamRes.json();
    return streamJson; 
  }

  // ==========================================
  // IF NO EPISODE WAS REQUESTED (Return normal show data)
  // ==========================================
  const targetUrl = `https://anime.nexus/series/${animeId}/${animeSlug}`;
  let originalLogoPng = null;
  try {
    const pageRes = await fetch(targetUrl, { headers: { ...headers, Accept: 'text/html' } });
    const html = await pageRes.text();
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
  } catch (_) { }

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
    anime: {
      id: animeId,
      slug: animeSlug,
      name: firstResult.name,
      url: targetUrl,
    },
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
