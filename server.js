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

// ---- Proxy support (to avoid Instagram blocking datacenter IPs) ----
// Set PROXY_URL in Render env, e.g.  http://user:pass@host:port
// Works with residential/rotating proxies (Webshare, BrightData, IPRoyal, etc.)
let proxyDispatcher = null;
const PROXY_URL = process.env.PROXY_URL || '';
if (PROXY_URL) {
  try {
    const { ProxyAgent } = require('undici');
    proxyDispatcher = new ProxyAgent(PROXY_URL);
    console.log('🌐 Using proxy for Instagram requests.');
  } catch (e) {
    console.warn('⚠️ Could not init proxy:', e.message);
  }
}

// Wrapper around fetch that routes through the proxy when configured
function igFetch(url, opts = {}) {
  if (proxyDispatcher) return fetch(url, Object.assign({}, opts, { dispatcher: proxyDispatcher }));
  return fetch(url, opts);
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ---- CORS (frontend Netlify, backend Render = different domains) ----
// Production me ALLOWED_ORIGIN env var set karo, e.g. https://mediagrabnow.com
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---- Instagram login cookie (FREE method) ----
// Paste your logged-in Instagram cookie string in Render env: IG_COOKIE
// Use a DUMMY/throwaway IG account (ban risk). How to get it: see COOKIE.md
const IG_COOKIE = process.env.IG_COOKIE || '';
// Extract csrftoken from the cookie (Instagram needs it as a header)
const IG_CSRF = (IG_COOKIE.match(/csrftoken=([^;]+)/) || [])[1] || '';

// Build headers that include the login cookie when available
function igHeaders(extra) {
  const h = Object.assign(
    {
      'User-Agent': UA,
      Accept: '*/*',
      'X-IG-App-ID': '936619743392459',
    },
    extra || {}
  );
  if (IG_COOKIE) {
    h['Cookie'] = IG_COOKIE;
    if (IG_CSRF) h['X-CSRFToken'] = IG_CSRF;
  }
  return h;
}

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
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'instagram120.p.rapidapi.com';

async function fetchViaRapidAPI(rawUrl) {
  if (!RAPIDAPI_KEY) return null; // not configured

  // instagram120 API: POST /api/instagram/links  body {url}
  // Response: [ { urls:[{url,name,subName,extension,quality}], meta:{title,sourceUrl}, pictureUrl } ]
  try {
    const res = await fetch('https://' + RAPIDAPI_HOST + '/api/instagram/links', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST,
      },
      body: JSON.stringify({ url: rawUrl }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const items = Array.isArray(json) ? json : json && json.result ? json.result : [];
    if (!items.length) return null;

    const media = [];
    let title = 'Instagram post';

    items.forEach((it) => {
      if (it && it.meta && it.meta.title && title === 'Instagram post') {
        title = String(it.meta.title).slice(0, 90);
      }
      const thumb = it.pictureUrl || it.thumbnail || (it.meta && it.meta.pictureUrl) || '';
      const variants = Array.isArray(it.urls) ? it.urls : [];
      if (variants.length) {
        // pick the best video variant (highest quality) for this item
        const vids = variants.filter((v) => (v.extension || '').toLowerCase() === 'mp4' || (v.name || '').toUpperCase() === 'MP4');
        const imgs = variants.filter((v) => /jpg|jpeg|png|webp/i.test(v.extension || '') || /image|photo/i.test(v.name || ''));
        if (vids.length) {
          vids.sort((a, b) => (b.quality || 0) - (a.quality || 0));
          const best = vids[0];
          media.push({ type: 'video', url: best.url, thumb, quality: best.subName || (best.quality ? best.quality + 'p' : 'HD') });
        } else if (imgs.length) {
          media.push({ type: 'image', url: imgs[0].url, thumb: thumb || imgs[0].url, quality: 'Full' });
        } else {
          // unknown variant -> take first url
          media.push({ type: 'video', url: variants[0].url, thumb, quality: variants[0].subName || 'HD' });
        }
      } else if (thumb) {
        media.push({ type: 'image', url: thumb, thumb, quality: 'Full' });
      }
    });

    const seen = new Set();
    const uniq = media.filter((m) => m.url && !seen.has(m.url) && seen.add(m.url));
    if (uniq.length) return { title, media: uniq };
    return null;
  } catch (e) {
    return null;
  }
}

// BEST METHOD: mimic Instagram web browser GraphQL request (no auth required)
// Uses the public doc_id endpoint that returns xdt_api__v1__media__shortcode__web_info
async function fetchViaDocId(shortcode, baseHeaders) {
  // A few doc_id values used by IG web for shortcode media info.
  // If one stops working, the others or fallbacks below still try.
  const docIds = ['24368985919464652', '8845758582119845', '10015901848480474'];
  const headers = Object.assign({}, baseHeaders, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-IG-App-ID': '936619743392459',
    'X-FB-LSD': 'AVqbxe3J_YA',
    'Sec-Fetch-Site': 'same-origin',
    Origin: 'https://www.instagram.com',
    Referer: 'https://www.instagram.com/',
  });

  for (const docId of docIds) {
    try {
      const body =
        'variables=' +
        encodeURIComponent(JSON.stringify({ shortcode })) +
        '&doc_id=' +
        docId;
      const res = await igFetch('https://www.instagram.com/graphql/query', {
        method: 'POST',
        headers,
        body,
      });
      if (!res.ok) continue;
      const json = await res.json();
      const item =
        json &&
        json.data &&
        json.data.xdt_api__v1__media__shortcode__web_info &&
        json.data.xdt_api__v1__media__shortcode__web_info.items &&
        json.data.xdt_api__v1__media__shortcode__web_info.items[0];
      if (item) {
        const out = [];
        extractMedia(item, out);
        // dedupe
        const seen = new Set();
        const media = out.filter((m) => m.url && !seen.has(m.url) && seen.add(m.url));
        if (media.length) {
          const title =
            (item.caption && item.caption.text && item.caption.text.slice(0, 80)) ||
            'Instagram post';
          return { title, media };
        }
      }
    } catch (e) {
      /* try next doc_id */
    }
  }
  return { title: '', media: [] };
}

async function fetchInstagram(rawUrl) {
  const base = cleanUrl(rawUrl);
  const shortcode = getShortcode(base);
  const headers = igHeaders();

  // 0) Try RapidAPI first (only if a key is configured)
  const viaApi = await fetchViaRapidAPI(base);
  if (viaApi && viaApi.media.length) return viaApi;

  // 0.5) BEST METHOD (2026): Instagram GraphQL doc_id endpoint, no login needed
  if (shortcode) {
    const viaDoc = await fetchViaDocId(shortcode, headers);
    if (viaDoc && viaDoc.media.length) return viaDoc;
  }

  // 1) public JSON view
  try {
    const res = await igFetch(base + '/?__a=1&__d=dis', { headers });
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
      const res = await igFetch(gql, { headers });
      if (res.ok) {
        const json = await res.json();
        const media = parseIgJson(
          (json.data && { graphql: { shortcode_media: json.data.shortcode_media } }) || json
        );
        if (media.length) return { title: 'Instagram post', media };
      }
    } catch (e) {}
  }

  // 3) scrape the page HTML (works when proxy returns the real page)
  try {
    const res = await igFetch(base + '/', { headers });
    if (res.ok) {
      const html = await res.text();
      const media = parseHtml(html);
      if (media.length) return { title: 'Instagram post', media };
    }
  } catch (e) {}

  return { title: '', media: [] };
}

// Extract media from a full Instagram HTML page (embedded JSON + og tags)
function parseHtml(html) {
  const media = [];
  const push = (type, url, thumb, q) => {
    if (url) media.push({ type, url: decodeUnicode(decodeHtml(url)), thumb: thumb ? decodeUnicode(decodeHtml(thumb)) : '', quality: q || 'HD' });
  };

  // a) modern embedded JSON: "video_versions":[{"url":"..."}]
  let m = html.match(/"video_versions":\s*\[\s*\{[^}]*?"url":"([^"]+)"/);
  if (m) push('video', m[1], (html.match(/"image_versions2".*?"url":"([^"]+)"/) || [])[1], '1080p');

  // b) "video_url":"..."
  if (!media.length) {
    m = html.match(/"video_url":"([^"]+)"/);
    if (m) push('video', m[1], (html.match(/"display_url":"([^"]+)"/) || [])[1]);
  }

  // c) JSON-LD contentUrl
  if (!media.length) {
    m = html.match(/"contentUrl":\s*"([^"]+\.mp4[^"]*)"/);
    if (m) push('video', m[1], (html.match(/"thumbnailUrl":\s*"([^"]+)"/) || [])[1]);
  }

  // d) any cdn mp4 in the page
  if (!media.length) {
    m = html.match(/https:\\?\/\\?\/[^"']*\.mp4[^"']*/);
    if (m) push('video', m[0]);
  }

  // e) image-only post
  if (!media.length) {
    const og = html.match(/property="og:image" content="([^"]+)"/);
    const di = html.match(/"display_url":"([^"]+)"/);
    if (di) push('image', di[1], di[1], 'Full');
    else if (og) push('image', og[1], og[1], 'Full');
  }

  // f) og:video fallback
  if (!media.length) {
    const ov = html.match(/property="og:video" content="([^"]+)"/);
    if (ov) push('video', ov[1], (html.match(/property="og:image" content="([^"]+)"/) || [])[1]);
  }

  // dedupe
  const seen = new Set();
  return media.filter((x) => x.url && !seen.has(x.url) && seen.add(x.url));
}

// decode \u002F etc. and escaped slashes from embedded JSON strings
function decodeUnicode(s) {
  if (!s) return s;
  return s
    .replace(/\\u0026/g, '&')
    .replace(/\\u003D/gi, '=')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/');
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
      return res.json({
        success: false,
        error:
          'Could not fetch this media. Make sure the post/reel is PUBLIC and the link is correct. (Instagram may also be rate-limiting this server — try again in a moment.)',
      });
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
    const upstream = await igFetch(u, { headers: igHeaders() });
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

// ---- Debug: see which Instagram method works from THIS server's IP ----
// Visit: https://your-app.onrender.com/api/debug?url=<instagram link>
app.get('/api/debug', async (req, res) => {
  const u = req.query.url;
  if (!u) return res.json({ error: 'Add ?url=<instagram link>' });
  const base = cleanUrl(u);
  const shortcode = getShortcode(base);
  const headers = igHeaders();
  const report = { shortcode, cookie: IG_COOKIE ? 'ON' : 'OFF', proxy: PROXY_URL ? 'ON' : 'OFF', rapidapi: RAPIDAPI_KEY ? 'ON' : 'OFF', steps: [] };

  // RapidAPI direct test
  if (RAPIDAPI_KEY) {
    try {
      const r = await fetchViaRapidAPI(base);
      report.steps.push({ method: 'rapidapi', mediaFound: r ? r.media.length : 0 });
    } catch (e) {
      report.steps.push({ method: 'rapidapi', error: e.message });
    }
  }

  // doc_id
  try {
    const body = 'variables=' + encodeURIComponent(JSON.stringify({ shortcode })) + '&doc_id=24368985919464652';
    const r = await igFetch('https://www.instagram.com/graphql/query', {
      method: 'POST',
      headers: Object.assign({}, headers, {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://www.instagram.com',
        Referer: 'https://www.instagram.com/',
      }),
      body,
    });
    report.steps.push({ method: 'doc_id', status: r.status });
  } catch (e) {
    report.steps.push({ method: 'doc_id', error: e.message });
  }

  // ?__a=1
  try {
    const r = await igFetch(base + '/?__a=1&__d=dis', { headers });
    report.steps.push({ method: '__a=1', status: r.status });
  } catch (e) {
    report.steps.push({ method: '__a=1', error: e.message });
  }

  // og:scrape
  try {
    const r = await igFetch(base + '/', { headers });
    report.steps.push({ method: 'html', status: r.status });
  } catch (e) {
    report.steps.push({ method: 'html', error: e.message });
  }

  // final result
  try {
    const { media } = await fetchInstagram(base);
    report.mediaFound = media.length;
  } catch (e) {
    report.fetchError = e.message;
  }
  res.json(report);
});

app.listen(PORT, () => {
  console.log('✅ MediaGrabNow running at http://localhost:' + PORT);
});
