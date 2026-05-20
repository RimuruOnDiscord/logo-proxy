// api/anime.js — Vercel Serverless Function

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Now accepts an optional "ep" parameter (e.g., ?q=naruto&ep=1)
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
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
  };

  // STEP 1: Search for the anime
  const searchApiUrl = `https://api.anime.nexus/api/anime/shows?search=${encodeURIComponent(searchQuery)}&sortBy=name+asc&page=1&includes[]=poster`;
  const searchRes = await fetch(searchApiUrl, { headers });
  if (!searchRes.ok) throw new Error(`Search API responded with ${searchRes.status}`);
  const searchData = await searchRes.json();
  const firstResult = searchData?.data?.[0];

  if (!firstResult) {
    return { success: false, error: `No anime found for: "${searchQuery}"` };
  }

  const animeId = firstResult.id;
  const animeSlug = firstResult.slug;
  const targetUrl = `https://anime.nexus/series/${animeId}/${animeSlug}`;

  // STEP 2: Scrape series page for the logo
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
  } catch (_) {
    // Logo scraping is non-critical
  }

  // STEP 3: Fetch episodes list
  const episodesApiUrl = `https://api.anime.nexus/api/anime/details/episodes?id=${animeId}&page=1&perPage=24&order=asc&fillers=true&recaps=true`;
  const episodesRes = await fetch(episodesApiUrl, { headers });
  const episodesData = await episodesRes.json();

  let targetEpisodeId = null;

  const episodes = (episodesData.data || []).map(ep => {
    // If the user requested a specific episode, grab its ID
    if (targetEp && String(ep.number) === String(targetEp)) {
      targetEpisodeId = ep.id;
    }

    return {
      id: ep.id,
      number: ep.number,
      title: ep.title,
      thumbnail: ep.image?.resized?.['1920x1080']
        ? `https://anime.delivery${ep.image.resized['1920x1080']}`
        : null,
      stream: null // Default to null
    };
  });

  // STEP 4: Fetch Stream ONLY for the requested episode
  let streamInfo = null;
  if (targetEpisodeId) {
    try {
      const streamApiUrl = `https://api.anime.nexus/api/anime/details/episode/stream?id=${targetEpisodeId}&fillers=true&recaps=true`;
      const streamRes = await fetch(streamApiUrl, { headers });
      if (streamRes.ok) {
        const streamJson = await streamRes.json();
        const sData = streamJson.data;

        if (sData) {
          streamInfo = {
            hls: sData.hls || null,
            subtitles: sData.subtitles || [],
            audio_languages: sData.video_meta?.audio_languages || [],
            qualities: sData.video_meta?.qualities || {},
            thumbnails: sData.thumbnails || null
          };
        }
      }
    } catch (err) {
      // Ignore stream fetch failure
    }
  }

  // Inject the stream info ONLY into the requested episode object
  if (streamInfo) {
    const epIndex = episodes.findIndex(e => String(e.number) === String(targetEp));
    if (epIndex !== -1) {
      episodes[epIndex].stream = streamInfo;
    }
  }

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
