// MediaGrabNow — Instagram downloader backend
// Run:  npm install   then   npm start
// Opens on http://localhost:3000
//
// NOTE: Instagram frequently changes its private endpoints and may block
// server IPs / require login for some content. This works best for PUBLIC
// posts/reels. For production scale, use an official API or a maintained
// 3rd-party API and add your key in fetchViaRapidAPI().

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function cleanUrl(u) {
  try {
    const parsed = new URL(u.trim());
    parsed.search = '';
    return parsed.toString().replace(/\/$/, '');
  } catch (e) {
    return (u || '').trim();
  }
}

function getShortcode(u) {
  const m = u.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// Pull every video/image URL out of an Instagram media JSON object
function extractMedia(node, out) {
  if (!node || typeof node !== 'object') return;

  // GraphQL style
  if (node.video_url) out.push({ type: 'video', quality: 'HD', url: node.video_url, thumb: node.display_url || node.thumbnail_src || '' });
  else if (node.display_url && node.is_video === false) out.push({ type: 'image', quality: 'Full', url: node.display_url, thumb: node.display_url });

  // API v1 style
  if (Array.isArray(node.video_versions) && node.video_versions.length) {
    const best = node.video_versions[0];
    out.push({ type: 'video', quality: (best.height || '') + 'p', url: best.url, thumb: (node.image_versions2 && node.image_versions2.candidates && node.image_versions2.candidates[0] && node.image_versions2.candidates[0].url) || '' });
  } else if (node.image_versions2 && node.image_versions2.candidates && node.image_versions2.candidates.length && !node.video_versions) {
    const best = node.image_versions2.candidates[0];
    out.push({ type: 'image', quality: (best.height || '') + 'px', url: best.url, thumb: best.url });
  }

  // Carousel children
  const children =
    (node.edge_sidecar_to_children && node.edge_sidecar_to_children.edges) ||
    node.carousel_media ||
    null;
  if (Array.isArray(children)) {
    children.forEach((c) => extractMedia(c.node || c, out));
  }
}

function parseIgJson(json) {
  const out = [];
  // ?__a=1 shape
  const item =
    (json.graphql && json.graphql.shortcode_media) ||
    (json.items && json.items[0]) ||
    (json.data && json.data.shortcode_media) ||
    json;
  extractMedia(item, out);

  // dedupe by url
  const seen = new Set();
  return out.filter((m) => m.url && !seen.has(m.url) && seen.add(m.url));
}

// ---- Option A: 3rd-party RapidAPI (recommended, most reliable) ----
// 1) Get a free key at https://rapidapi.com  (search "Instagram Downloader")
// 2) Subscribe to a free plan, copy your key
// 3) Set it below or via env:  RAPIDAPI_KEY=xxxx npm start
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';            // <-- paste your key here
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'instagram-downloader-download-instagram-videos-stories.p.rapidapi.com';

async function fetchViaRapidAPI(rawUrl) {
  if (!RAPIDAPI_KEY) return null; // not configured
  try {
    const endpoint =
      'https://' + RAPIDAPI_HOST + '/index?url=' + encodeURIComponent(rawUrl);
    const res = await fetch(endpoint, {
      headers: {
        'X-RapidAPI-Key': RAPIDAPI_KEY,
        'X-RapidAPI-Host': RAPIDAPI_HOST,
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    // Different APIs return different shapes; normalize the common ones:
    const media = [];
    const push = (type, url, thumb, q) => { if (url) media.push({ type, url, thumb: thumb || '', quality: q || 'HD' }); };

    if (Array.isArray(json.media)) {
      json.media.forEach((m) => push(m.type === 'image' ? 'image' : 'video', m.url || m.download_url, m.thumbnail, m.quality));
    } else if (Array.isArray(json)) {
      json.forEach((m) => push(m.type === 'image' ? 'image' : 'video', m.url || m.download_url, m.thumbnail, m.quality));
    } else {
      if (json.video || json.video_url) push('video', json.video || json.video_url, json.thumbnail || json.thumb, 'HD');
      if (json.image || json.image_url || json.thumbnail) push('image', json.image || json.image_url || json.thumbnail, json.thumbnail, 'Full');
    }
    if (media.length) return { title: json.title || 'Instagram post', media };
    return null;
  } catch (e) {
    return null;
  }
}

async function fetchInstagram(rawUrl) {
  const base = cleanUrl(rawUrl);
  const shortcode = getShortcode(base);
  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    'X-IG-App-ID': '936619743392459',
  };

  // 0) Try RapidAPI first (most reliable for public + most reels)
  const viaApi = await fetchViaRapidAPI(base);
  if (viaApi && viaApi.media.length) return viaApi;

  // 1) public JSON view
  try {
    const res = await fetch(base + '/?__a=1&__d=dis', { headers });
    if (res.ok) {
      const txt = await res.text();
      try {
        const json = JSON.parse(txt);
        const media = parseIgJson(json);
        if (media.length) return { title: 'Instagram post', media };
      } catch (e) {}
    }
  } catch (e) {}

  // 2) GraphQL by shortcode
  if (shortcode) {
    const gql =
      'https://www.instagram.com/graphql/query/?query_hash=9f8827793ef34641b2fb195d4d41151c&variables=' +
      encodeURIComponent(JSON.stringify({ shortcode }));
    try {
      const res = await fetch(gql, { headers });
      if (res.ok) {
        const json = await res.json();
        const media = parseIgJson(
          (json.data && { graphql: { shortcode_media: json.data.shortcode_media } }) || json
        );
        if (media.length) return { title: 'Instagram post', media };
      }
    } catch (e) {}
  }

  // 3) scrape the page HTML for og:video / og:image as a last resort
  try {
    const res = await fetch(base + '/', { headers });
    if (res.ok) {
      const html = await res.text();
      const media = [];
      const vid = html.match(/property="og:video" content="([^"]+)"/);
      const img = html.match(/property="og:image" content="([^"]+)"/);
      if (vid) media.push({ type: 'video', quality: 'HD', url: decodeHtml(vid[1]), thumb: img ? decodeHtml(img[1]) : '' });
      else if (img) media.push({ type: 'image', quality: 'Full', url: decodeHtml(img[1]), thumb: decodeHtml(img[1]) });
      if (media.length) return { title: 'Instagram post', media };
    }
  } catch (e) {}

  return { title: '', media: [] };
}

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, '/')
    .replace(/&#39;/g, "'");
}

// ---- API: resolve a link to media URLs ----
app.post('/api/download', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !/instagram\.com/i.test(url)) {
    return res.status(400).json({ success: false, error: 'Please provide a valid Instagram URL.' });
  }
  try {
    const { title, media } = await fetchInstagram(url);
    if (!media.length) {
      const hint = RAPIDAPI_KEY
        ? 'Could not fetch media. The post may be private, deleted, or the API has no data. Try a public post/reel.'
        : 'Could not fetch media. Instagram now blocks anonymous requests. Add a free RAPIDAPI_KEY in server.js to enable real downloads (see README.md).';
      return res.json({ success: false, error: hint });
    }
    res.json({ success: true, title, media });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Server error: ' + e.message });
  }
});

// ---- API: proxy/stream the file so the browser downloads it ----
app.get('/api/file', async (req, res) => {
  const u = req.query.u;
  const name = req.query.name || 'mediagrabnow';
  if (!u) return res.status(400).send('Missing url');
  try {
    const upstream = await fetch(u, { headers: { 'User-Agent': UA } });
    if (!upstream.ok) return res.status(502).send('Upstream error');
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    // Node 20 supports streaming the web ReadableStream
    const { Readable } = require('stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    res.status(500).send('Download failed: ' + e.message);
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log('✅ MediaGrabNow running at http://localhost:' + PORT);
});
