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

// Parse Instagram's DASH manifest XML to find the highest-quality video MP4 URL.
// This is where the REAL full-quality file lives (video_versions is often compressed).
function parseDashVideos(dashXml) {
  if (!dashXml || typeof dashXml !== 'string') return [];
  const reps = [];
  const repRegex = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g;
  let m;
  while ((m = repRegex.exec(dashXml)) !== null) {
    const attrs = m[1] || '';
    const inner = m[2] || '';
    // skip audio-only representations
    if (/mimeType="audio/i.test(attrs)) continue;
    // must be a video (mimeType video, or has a quality label / frameRate)
    const isVid = /mimeType="video/i.test(attrs) || /FBQualityLabel=/i.test(attrs) || /frameRate=/i.test(attrs);
    if (!isVid) continue;

    const height = parseInt((attrs.match(/\bheight="(\d+)"/) || [])[1] || '0', 10);
    const width = parseInt((attrs.match(/\bwidth="(\d+)"/) || [])[1] || '0', 10);
    const bandwidth = parseInt((attrs.match(/\bbandwidth="(\d+)"/) || [])[1] || '0', 10);
    const size = parseInt((attrs.match(/FBContentLength="(\d+)"/) || [])[1] || '0', 10);
    const label = (attrs.match(/FBQualityLabel="([^"]+)"/) || [])[1] || (height ? height + 'p' : '');

    let url = (inner.match(/<BaseURL>([\s\S]*?)<\/BaseURL>/) || [])[1] || '';
    url = url.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').trim();
    if (url && /^https?:\/\//i.test(url)) {
      reps.push({ width, height, bandwidth, size, label, url });
    }
  }
  // highest quality first: by height, then bandwidth, then file size
  reps.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth) || (b.size - a.size));
  return reps;
}

// Pull the AUDIO-ONLY track URL from a DASH manifest (m4a, no video).
// Lets us offer real audio download without ffmpeg.
function parseDashAudio(dashXml) {
  if (!dashXml || typeof dashXml !== 'string') return '';
  const repRegex = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g;
  let m, best = '', bestBw = -1;
  while ((m = repRegex.exec(dashXml)) !== null) {
    const attrs = m[1] || '', inner = m[2] || '';
    if (!/mimeType="audio/i.test(attrs)) continue;
    const bw = parseInt((attrs.match(/\bbandwidth="(\d+)"/) || [])[1] || '0', 10);
    let url = (inner.match(/<BaseURL>([\s\S]*?)<\/BaseURL>/) || [])[1] || '';
    url = url.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').trim();
    if (url && /^https?:\/\//i.test(url) && bw > bestBw) { bestBw = bw; best = url; }
  }
  return best;
}

// Pull every video/image URL out of an Instagram media JSON object
function extractMedia(node, out) {
  if (!node || typeof node !== 'object') return;

  // If this node is a carousel/album, ONLY process its children (skip the cover)
  const children =
    (node.edge_sidecar_to_children && node.edge_sidecar_to_children.edges) ||
    node.carousel_media ||
    null;
  if (Array.isArray(children) && children.length) {
    children.forEach((c) => extractMedia(c.node || c, out));
    return;
  }

  // Detect if this node is a video (any of these signals)
  const isVideoNode =
    node.is_video === true ||
    node.media_type === 2 ||
    !!node.video_url ||
    (Array.isArray(node.video_versions) && node.video_versions.length > 0) ||
    !!node.video_dash_manifest;

  if (isVideoNode) {
    const thumb =
      (node.image_versions2 && node.image_versions2.candidates && node.image_versions2.candidates[0] && node.image_versions2.candidates[0].url) ||
      node.display_url || node.thumbnail_src || '';

    // IMPORTANT: Instagram's DASH manifest splits VIDEO and AUDIO into separate tracks,
    // so a DASH video URL has NO sound. Without ffmpeg we can't merge them.
    // video_versions / video_url are PROGRESSIVE (muxed) files = video + audio together.
    // So we ALWAYS prefer muxed sources to guarantee the download has sound.

    // 1) video_versions array (muxed: video + audio) -- dedupe by height, highest first
    const vvSeen = new Set();
    const vvVids = [];
    (node.video_versions || []).forEach((v) => {
      const h = v.height || 0;
      if (v.url && !vvSeen.has(h)) { vvSeen.add(h); vvVids.push({ height: h, label: (h ? h + 'p' : 'HD'), url: v.url }); }
    });
    vvVids.sort((a, b) => b.height - a.height);

    // 2) build final list from MUXED sources only (sound guaranteed)
    const all = [];
    vvVids.forEach((v) => all.push(v));
    if (node.video_url) all.push({ height: 0, label: 'HD', url: node.video_url });

    const urlSeen = new Set();
    const merged = all.filter((v) => v.url && !urlSeen.has(v.url) && urlSeen.add(v.url));
    const hSeen = new Set();
    const finalVids = [];
    merged.forEach((v) => {
      const key = v.height || ('u' + v.url.slice(-12));
      if (!hSeen.has(key)) { hSeen.add(key); finalVids.push(v); }
    });
    finalVids.sort((a, b) => b.height - a.height);

    // pure audio track from DASH (m4a, no video) -> real audio download without ffmpeg
    const audioUrl = parseDashAudio(node.video_dash_manifest);

    if (finalVids.length) {
      const best = finalVids[0];
      out.push({
        type: 'video',
        quality: best.label || (best.height ? best.height + 'p' : 'HD'),
        url: best.url,
        thumb,
        audioUrl: audioUrl || '',
        variants: finalVids.map((v) => ({ label: v.label || (v.height ? v.height + 'p' : 'HD'), url: v.url })),
      });
      return; // done with this node
    }
  }

  // GraphQL image style
  if (!isVideoNode && node.display_url && (node.is_video === false || node.media_type === 1) && !(node.image_versions2 && node.image_versions2.candidates)) {
    out.push({ type: 'image', quality: 'Full', url: node.display_url, thumb: node.display_url });
  }

  // API v1 image style
  if (node.image_versions2 && node.image_versions2.candidates && node.image_versions2.candidates.length && !isVideoNode) {
    const cands = node.image_versions2.candidates;
    const best = cands[0];
    // build quality variants from all candidate sizes (dedupe by width)
    const seenW = new Set();
    const variants = [];
    cands.forEach((c) => {
      const w = c.width || 0;
      if (!seenW.has(w)) { seenW.add(w); variants.push({ label: (c.width && c.height ? c.width + 'x' + c.height : 'img'), w, url: c.url }); }
    });
    variants.sort((a, b) => b.w - a.w);
    out.push({
      type: 'image',
      quality: (best.width ? best.width + 'px' : 'Full'),
      url: best.url,
      thumb: best.url,
      variants: variants.map((v) => ({ label: v.label, url: v.url })),
    });
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
        title = String(it.meta.title).slice(0, 200);
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

// Fetch STORIES via RapidAPI (works from datacenter IP, unlike direct IG story endpoints)
async function fetchStoriesViaRapidAPI(username) {
  if (!RAPIDAPI_KEY) return null;
  username = String(username).replace(/^@/, '').trim();
  try {
    const res = await fetch('https://' + RAPIDAPI_HOST + '/api/instagram/stories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST },
      body: JSON.stringify({ username }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const items = Array.isArray(json) ? json : (json && json.result ? json.result : []);
    if (!items.length) return null;
    const media = [];
    items.forEach((it) => extractMedia(it, media));
    const seen = new Set();
    const uniq = media.filter((m) => m.url && !seen.has(m.url) && seen.add(m.url));
    if (uniq.length) return { title: '@' + username + ' — stories', media: uniq };
    return null;
  } catch (e) { return null; }
}

// Fetch HIGHLIGHTS via RapidAPI. Two-step: get highlight list, then its stories.
async function fetchHighlightsViaRapidAPI(username, highlightId) {
  if (!RAPIDAPI_KEY) return null;
  username = String(username || '').replace(/^@/, '').trim();
  try {
    // If we already have a highlight id, get its stories directly
    let hid = highlightId || '';
    if (!hid && username) {
      // get the user's highlight albums, pick the first
      const r1 = await fetch('https://' + RAPIDAPI_HOST + '/api/instagram/highlights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST },
        body: JSON.stringify({ username }),
      });
      if (r1.ok) {
        const j1 = await r1.json();
        const albums = Array.isArray(j1) ? j1 : (j1 && j1.result ? j1.result : []);
        if (albums.length && albums[0].id) hid = String(albums[0].id).replace(/^highlight:/, '');
      }
    }
    if (!hid) return null;
    // get the stories inside that highlight (endpoint is camelCase, id needs highlight: prefix)
    const r2 = await fetch('https://' + RAPIDAPI_HOST + '/api/instagram/highlightStories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST },
      body: JSON.stringify({ highlightId: 'highlight:' + hid }),
    });
    if (!r2.ok) return null;
    const j2 = await r2.json();
    const items = Array.isArray(j2) ? j2 : (j2 && j2.result ? j2.result : []);
    if (!items.length) return null;
    const media = [];
    items.forEach((it) => extractMedia(it, media));
    const seen = new Set();
    const uniq = media.filter((m) => m.url && !seen.has(m.url) && seen.add(m.url));
    if (uniq.length) return { title: '@' + (username || 'instagram') + ' — highlights', media: uniq };
    return null;
  } catch (e) { return null; }
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
            (item.caption && item.caption.text && item.caption.text.slice(0, 200)) ||
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

// ---- Profile picture by username ----
async function fetchProfilePic(username) {
  username = String(username).replace(/^@/, '').trim();
  try {
    const res = await igFetch(
      'https://www.instagram.com/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username),
      { headers: igHeaders({ Referer: 'https://www.instagram.com/' + username + '/' }) }
    );
    if (res.ok) {
      const json = await res.json();
      const u = json && json.data && json.data.user;
      const pic = u && (u.profile_pic_url_hd || u.profile_pic_url);
      if (pic) {
        return {
          title: '@' + u.username + (u.full_name ? ' — ' + u.full_name : ''),
          media: [{ type: 'image', quality: 'HD', url: pic, thumb: pic }],
          userId: u.id,
        };
      }
    }
  } catch (e) {}

  // Fallback: scrape profile page for og:image (when API is rate-limited)
  try {
    const r = await igFetch('https://www.instagram.com/' + username + '/', { headers: igHeaders() });
    if (r.ok) {
      const html = await r.text();
      const og = html.match(/property="og:image" content="([^"]+)"/);
      if (og) {
        const pic = decodeHtml(og[1]);
        return { title: '@' + username, media: [{ type: 'image', quality: 'HD', url: pic, thumb: pic }] };
      }
    }
  } catch (e) {}

  return { title: '', media: [] };
}

// ---- Stories by username ----
async function fetchStories(username, storyId) {
  username = String(username).replace(/^@/, '').trim();

  const mobileHeaders = igHeaders({
    'User-Agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 12_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 105.0.0.11.118 (iPhone11,8; iOS 12_3_1; en_US; en-US; scale=2.00; 828x1792; 165586599)',
    'X-IG-App-ID': '936619743392459',
    'X-IG-Capabilities': '3brTvw==',
    'Accept-Language': 'en-US',
  });

  let sawAuthError = false;

  // FAST PATH: if a story link with a media id was pasted, fetch it directly
  if (storyId) {
    try {
      const r = await igFetch('https://i.instagram.com/api/v1/media/' + storyId + '/info/', { headers: mobileHeaders });
      if (r.status === 403 || r.status === 401) sawAuthError = true;
      else if (r.ok) {
        const j = await r.json();
        const it = j && j.items && j.items[0];
        if (it) {
          const media = [];
          extractMedia(it, media);
          const seen = new Set();
          const uniq = media.filter((m) => m.url && !seen.has(m.url) && seen.add(m.url));
          if (uniq.length) return { title: '@' + username + ' — story', media: uniq };
        }
      }
    } catch (e) {}
  }

  // first get the user id
  let uid = '';
  try {
    const r = await igFetch(
      'https://www.instagram.com/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username),
      { headers: igHeaders({ Referer: 'https://www.instagram.com/' + username + '/' }) }
    );
    if (r.ok) {
      const j = await r.json();
      uid = j && j.data && j.data.user && j.data.user.id;
    }
  } catch (e) {}
  if (!uid) return { title: '', media: [], authError: sawAuthError };

  const tryEndpoints = [
    'https://i.instagram.com/api/v1/feed/user/' + uid + '/reel_media/',
    'https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=' + uid,
    'https://i.instagram.com/api/v1/feed/user/' + uid + '/story/',
    'https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=' + uid,
  ];

  for (const ep of tryEndpoints) {
    try {
      const res = await igFetch(ep, { headers: mobileHeaders });
      if (res.status === 403 || res.status === 401) { sawAuthError = true; continue; }
      if (!res.ok) continue;
      const json = await res.json();
      // reels_media shape OR single story shape
      const reel =
        (json && json.reels && json.reels[uid]) ||
        (json && json.reels_media && json.reels_media[0]) ||
        (json && json.reel) ||
        json;
      let items = (reel && reel.items) || [];
      if (!items.length) continue;
      // if a specific story id was given, keep only that one
      if (storyId) {
        const only = items.filter((it) => String(it.pk || it.id || '').indexOf(storyId) === 0 || String(it.pk) === storyId);
        if (only.length) items = only;
      }
      const media = [];
      items.forEach((it) => extractMedia(it, media));
      const seen = new Set();
      const uniq = media.filter((m) => m.url && !seen.has(m.url) && seen.add(m.url));
      if (uniq.length) return { title: '@' + username + ' — stories', media: uniq };
    } catch (e) {}
  }
  return { title: '', media: [], authError: sawAuthError };
}

// ---- Highlights (instagram.com/stories/highlights/<id>/) ----
async function fetchHighlights(highlightId) {
  const mobileHeaders = igHeaders({
    'User-Agent':
      'Instagram 269.0.0.18.75 Android (29/10; 420dpi; 1080x2129; samsung; SM-G973F; beyond1; exynos9820; en_US; 314665256)',
    'X-IG-App-ID': '936619743392459',
    'X-IG-Capabilities': '3brTvw==',
    'Accept-Language': 'en-US',
  });
  let sawAuthError = false;
  const id = String(highlightId).replace(/^highlight:/, '');
  const endpoints = [
    'https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=highlight:' + id,
    'https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=highlight:' + id,
  ];
  for (const ep of endpoints) {
    try {
      const res = await igFetch(ep, { headers: mobileHeaders });
      if (res.status === 403 || res.status === 401) { sawAuthError = true; continue; }
      if (!res.ok) continue;
      const json = await res.json();
      const reel =
        (json && json.reels && json.reels['highlight:' + id]) ||
        (json && json.reels && Object.values(json.reels)[0]) ||
        null;
      const items = (reel && reel.items) || [];
      if (!items.length) continue;
      const media = [];
      items.forEach((it) => extractMedia(it, media));
      const seen = new Set();
      const uniq = media.filter((m) => m.url && !seen.has(m.url) && seen.add(m.url));
      if (uniq.length) return { title: 'Instagram highlight', media: uniq };
    } catch (e) {}
  }
  return { title: '', media: [], authError: sawAuthError };
}

async function fetchInstagram(rawUrl) {
  const base = cleanUrl(rawUrl);
  const shortcode = getShortcode(base);
  const headers = igHeaders();

  // 0) BEST METHOD: Instagram GraphQL doc_id (cookie) — returns FULL carousel
  if (shortcode) {
    const viaDoc = await fetchViaDocId(shortcode, headers);
    if (viaDoc && viaDoc.media.length) return viaDoc;
  }

  // 0.5) RapidAPI fallback (only if a key is configured)
  const viaApi = await fetchViaRapidAPI(base);
  if (viaApi && viaApi.media.length) return viaApi;

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
  const { url, type } = req.body || {};
  if (!url || !String(url).trim()) {
    return res.status(400).json({ success: false, error: 'Please paste a link or username.' });
  }
  const input = String(url).trim();

  try {
    let result = { title: '', media: [] };
    const mode = (type || '').toLowerCase();

    // username helper: pull @name or plain name from a profile URL or raw text
    const usernameFromInput = () => {
      // stories link: instagram.com/stories/<username>/<id>
      var sm = input.match(/instagram\.com\/stories\/([A-Za-z0-9._]+)/i);
      if (sm) return sm[1];
      const m = input.match(/instagram\.com\/([A-Za-z0-9._]+)/);
      if (m && !/^(p|reel|reels|tv|stories|explore|s)$/i.test(m[1])) return m[1];
      if (/^@?[A-Za-z0-9._]+$/.test(input)) return input;
      return '';
    };
    // specific story id (if a direct story link was pasted)
    const storyIdFromInput = () => {
      var sm = input.match(/instagram\.com\/stories\/[A-Za-z0-9._]+\/(\d+)/i);
      return sm ? sm[1] : '';
    };
    // highlight id: instagram.com/stories/highlights/<id>/  OR  /s/<id>
    const highlightIdFromInput = () => {
      var hm = input.match(/instagram\.com\/stories\/highlights\/(\d+)/i) || input.match(/\/s\/([A-Za-z0-9_-]+)/i);
      return hm ? hm[1] : '';
    };

    if (mode === 'profile' || mode === 'viewer') {
      const un = usernameFromInput();
      if (!un) return res.json({ success: false, error: 'Enter an Instagram username (e.g. @nasa).' });
      result = await fetchProfilePic(un);
      if (!result.media.length) return res.json({ success: false, error: 'Could not fetch this profile. Check the username.' });
    } else if (mode === 'highlights') {
      const un = usernameFromInput();
      const hid = highlightIdFromInput();
      // RapidAPI first (works from datacenter), then direct fallback
      result = (await fetchHighlightsViaRapidAPI(un, hid)) || (hid ? await fetchHighlights(hid) : { title: '', media: [] });
      if (!result.media.length) {
        return res.json({ success: false, error: 'Could not fetch highlights. Make sure the account is public and has highlights.' });
      }
      res.json({ success: true, title: result.title || 'Instagram highlights', kind: 'story', media: result.media });
      return;
    } else if (mode === 'story') {
      // highlight link?
      const hid = highlightIdFromInput();
      if (hid) {
        // RapidAPI first, then direct
        result = (await fetchHighlightsViaRapidAPI('', hid)) || await fetchHighlights(hid);
        if (!result.media.length) {
          return res.json({ success: false, error: 'Could not fetch this highlight. Make sure the link is correct and public.' });
        }
        res.json({ success: true, title: result.title || 'Instagram highlight', kind: 'story', media: result.media });
        return;
      }
      const un = usernameFromInput();
      if (!un) return res.json({ success: false, error: 'Paste a story link (instagram.com/stories/...) or enter a username.' });
      // RapidAPI first (works from datacenter IP), then direct method as fallback
      result = (await fetchStoriesViaRapidAPI(un)) || await fetchStories(un, storyIdFromInput());
      if (!result.media.length) {
        return res.json({ success: false, error: 'No active public stories found for this user (they may have no story right now, or the account is private).' });
      }
    } else {
      // video / photo / reels / igtv / carousel / audio -> normal link flow
      if (!/instagram\.com/i.test(input)) {
        return res.json({ success: false, error: 'Please paste a valid Instagram link (instagram.com/...).' });
      }
      result = await fetchInstagram(input);
      if (!result.media.length) {
        return res.json({
          success: false,
          error: 'Could not fetch this media. Make sure the post/reel is PUBLIC and the link is correct.',
        });
      }
      // audio mode: serve the PURE AUDIO track (m4a from DASH) so the user gets sound only,
      // not the whole video. Falls back to the video file only if no separate audio track exists.
      if (mode === 'audio') {
        result.media = result.media
          .filter((m) => m.type === 'video')
          .map((m) => ({
            type: 'video',
            audio: true,
            quality: 'Audio',
            url: m.audioUrl || m.url,          // prefer real audio-only URL
            isPureAudio: !!m.audioUrl,         // true when we have a separate audio track
            thumb: m.thumb || '',
          }));
        if (!result.media.length) return res.json({ success: false, error: 'No audio found (this post has no video).' });
      }
    }

    // Decide a "kind" so the frontend can show the right shape
    var kind = mode;
    if (mode === 'profile' || mode === 'viewer') kind = 'profile';
    else if (mode === 'story') kind = 'story';
    else if (mode === 'audio') kind = 'audio';
    else if (/\/reel|\/reels/i.test(input) || mode === 'reels') kind = 'reel';
    else if (result.media.length > 1) kind = 'carousel';
    else if (result.media[0] && result.media[0].type === 'image') kind = 'photo';
    else kind = 'video';

    res.json({ success: true, title: result.title || 'Instagram media', caption: result.title || '', kind: kind, media: result.media });
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
// lightweight keep-alive endpoint for UptimeRobot (prevents Render sleep)
app.get('/ping', (_req, res) => res.status(200).send('pong'));

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

app.listen(PORT, '0.0.0.0', () => {
  console.log('✅ MediaGrabNow running on port ' + PORT);
});
