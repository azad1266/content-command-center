// Content Command Center — Daily Content Ops
// Runs server-side via GitHub Actions (never in the browser).
// Uses the GEMINI_API_KEY / GEMINI_API_KEY1 (and optional YOUTUBE_API_KEY) repo secrets to:
//   1. Auto-replenish the Topic Backlog (meta/topicsList) up to 100 active topics.
//   2. Refresh Trending Topics (meta/trending) using Google Search grounding.
//   3. Run Content Research (meta/contentResearch) — real viral signal pulled from
//      YouTube (Data API), Reddit (public JSON, no key needed), and an Instagram-Reels
//      proxy signal via Gemini+Google Search (Instagram has no free trending API, so
//      this is the honest substitute — never faked/invented data).
// Writes results straight to Firestore (rules are open, so the public web
// config below is enough — no service account / Admin SDK needed).

import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, getDocs, collection, setDoc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyAgTawBW7-xwxgCRQ4S4eJaCB-aTsEm9rE",
  authDomain: "addy-content-machine.firebaseapp.com",
  projectId: "addy-content-machine",
  storageBucket: "addy-content-machine.firebasestorage.app",
  messagingSenderId: "935601887728",
  appId: "1:935601887728:web:ba320d87e9e88ae9f2e535",
  measurementId: "G-JM9T9CLHMX"
};

const KEYS = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY1].filter(Boolean);
if (!KEYS.length) {
  console.error('No Gemini key found in secrets (GEMINI_API_KEY / GEMINI_API_KEY1). Aborting.');
  process.exit(1);
}
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

const CATEGORIES = ["Business Collapse/Failure","Hidden Business Models","Founder Psychology & Decisions","Marketing Psychology Tricks","Company Rivalries & Wars","Pricing Psychology","Indian Business Stories","Global Tech Secrets","Scams & Frauds","Underdog/Comeback Stories"];

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function callGeminiWithKey(key, prompt, grounded) {
  const body = { contents: [{ parts: [{ text: prompt }] }] };
  if (grounded) body.tools = [{ google_search: {} }];
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('Gemini error: ' + t.slice(0, 300));
  }
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
}

async function callGemini(prompt, grounded = false) {
  let lastErr;
  for (const key of KEYS) {
    try { return await callGeminiWithKey(key, prompt, grounded); }
    catch (e) { lastErr = e; console.error('Key failed, trying next:', e.message); }
  }
  throw lastErr || new Error('All Gemini keys failed.');
}

function parseTrendingBlocks(text) {
  const blocks = text.split(/\n(?=TITLE:)/i);
  const items = [];
  blocks.forEach(b => {
    const title = (b.match(/TITLE:\s*(.+)/i) || [])[1];
    const cat = (b.match(/CATEGORY:\s*(.+)/i) || [])[1];
    const why = (b.match(/WHY_TRENDING:\s*(.+)/i) || [])[1];
    const source = (b.match(/SOURCE:\s*(.+)/i) || [])[1];
    if (title && source) {
      items.push({
        title: title.trim(),
        cat: CATEGORIES.find(c => c.toLowerCase() === (cat || '').trim().toLowerCase()) || CATEGORIES[0],
        why: (why || '').trim(),
        source: source.trim()
      });
    }
  });
  return items;
}

async function replenishBacklog() {
  const listSnap = await getDoc(doc(db, 'meta', 'topicsList'));
  let topics = listSnap.exists() ? (listSnap.data().topics || []) : [];

  const prodSnap = await getDocs(collection(db, 'topics'));
  const posted = new Set();
  prodSnap.forEach(d => { if (d.data().donePosted) posted.add(String(d.id)); });

  const activeCount = () => topics.filter(t => !posted.has(String(t.id))).length;
  console.log('Backlog: active =', activeCount(), '/ total =', topics.length);

  let added = 0;
  const MAX_ADD_PER_RUN = 5;
  while (activeCount() < 100 && added < MAX_ADD_PER_RUN) {
    const existingTitles = topics.map(t => t.title);
    const prompt = `You are a topic researcher for a Hindi business-storytelling YouTube Shorts channel. The channel's 10 categories are: ${CATEGORIES.join(', ')}.\n\nPropose ONE brand-new video topic idea that is NOT a duplicate or close variant of any topic in this existing list:\n${existingTitles.map(t => '- ' + t).join('\n')}\n\nThe title must be a punchy Hindi/Hinglish clickbait-style title matching the tone of these examples: "Kodak ne Digital Camera Banaya Tha, Phir Bhi Kyun Dooba?", "McDonald's Asli Business Burger Nahi, Real Estate Hai".\n\nReturn ONLY in this exact format, nothing else:\nCATEGORY: <one of the 10 categories exactly as listed>\nTITLE: <the new Hindi/Hinglish title>`;
    let out;
    try { out = await callGemini(prompt); }
    catch (e) { console.error('Topic generation failed, stopping replenish:', e.message); break; }

    const catMatch = out.match(/CATEGORY:\s*(.+)/i);
    const titleMatch = out.match(/TITLE:\s*(.+)/i);
    if (!catMatch || !titleMatch) { console.log('Could not parse a topic from model output, skipping.'); continue; }

    const cat = CATEGORIES.find(c => c.toLowerCase() === catMatch[1].trim().toLowerCase()) || CATEGORIES[0];
    const title = titleMatch[1].trim();
    const isDup = topics.some(t => t.title.toLowerCase() === title.toLowerCase());
    if (isDup || !title) { console.log('Duplicate or empty title, skipping.'); continue; }

    const maxId = topics.reduce((m, t) => Math.max(m, t.id), 0);
    topics.push({ id: maxId + 1, cat, title, source: 'auto', addedAt: Date.now() });
    added++;
    console.log('Added topic #' + (maxId + 1) + ':', title);
  }

  if (added > 0) {
    await setDoc(doc(db, 'meta', 'topicsList'), { topics });
    console.log('Saved', added, 'new topic(s) to backlog.');
  } else {
    console.log('Backlog already healthy — nothing added.');
  }
}

async function refreshTrending() {
  const prompt = `Search the web for what is genuinely trending RIGHT NOW (this week) in: AI tools & AI agents, business news, startup stories, and tech industry — things that would make a great Hindi YouTube Shorts business-storytelling video.\n\nFind the 8 best real, currently-trending topics. For EACH one, respond in EXACTLY this block format (repeat 8 times, one block per topic):\n\nTITLE: <a punchy Hindi/Hinglish video title idea>\nCATEGORY: <closest fit from: ${CATEGORIES.join(', ')}>\nWHY_TRENDING: <one line on why it's hot right now>\nSOURCE: <the real URL where you found this>\n\nOnly include topics you can back with a real, current, working source URL — do not invent or guess a trending topic without one.`;
  let text;
  try { text = await callGemini(prompt, true); }
  catch (e) { console.error('Trending refresh failed:', e.message); return; }

  const items = parseTrendingBlocks(text);
  if (!items.length) { console.log('Trending parse returned 0 items — leaving old data as-is.'); return; }

  await setDoc(doc(db, 'meta', 'trending'), { items, lastRefreshed: Date.now(), source: 'github-action' });
  console.log('Trending topics refreshed:', items.length, 'items.');
}

// ---- Content Research: real cross-platform viral signal ----

const YT_QUERIES = [
  'company collapse story',
  'business scam exposed',
  'hidden business model',
  'founder biggest mistake',
  'startup failure story',
  'business rivalry war'
];

async function fetchYouTubeSignal() {
  if (!YOUTUBE_API_KEY) {
    console.log('YOUTUBE_API_KEY not set — skipping YouTube signal (Reddit + Instagram-proxy signal will still run).');
    return [];
  }
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const items = [];
  for (const q of YT_QUERIES) {
    try {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=5&publishedAfter=${sevenDaysAgo}&q=${encodeURIComponent(q)}&key=${YOUTUBE_API_KEY}`;
      const res = await fetch(url);
      if (!res.ok) { console.error('YouTube search failed for "' + q + '":', res.status, (await res.text()).slice(0, 200)); continue; }
      const data = await res.json();
      (data.items || []).forEach(v => {
        items.push({
          title: v.snippet?.title || '',
          channel: v.snippet?.channelTitle || '',
          publishedAt: v.snippet?.publishedAt || '',
          url: 'https://youtube.com/watch?v=' + (v.id?.videoId || ''),
          queryMatched: q
        });
      });
    } catch (e) { console.error('YouTube fetch error for "' + q + '":', e.message); }
  }
  console.log('YouTube signal:', items.length, 'videos across', YT_QUERIES.length, 'queries.');
  return items;
}

const REDDIT_SUBS = ['business', 'Entrepreneur', 'startups', 'IndiaBusiness', 'technology', 'Scams', 'CorporateFacepalm'];
const REDDIT_UA = 'content-command-center-research/1.0 (by /u/azad1266)';

// Reddit blocks anonymous requests from datacenter/cloud IPs (like GitHub Actions
// runners) with a 403, even for public read-only JSON. The free, legitimate fix is
// Reddit's own OAuth "script app" flow (client_credentials grant) — free, no card,
// just two secrets (REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET) from a Reddit app you
// create once at reddit.com/prefs/apps. If those secrets aren't set, Reddit signal
// is skipped gracefully (YouTube + Instagram-proxy signal still run).
async function getRedditToken() {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  try {
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': REDDIT_UA
      },
      body: 'grant_type=client_credentials'
    });
    if (!res.ok) { console.error('Reddit OAuth token request failed:', res.status, (await res.text()).slice(0, 200)); return null; }
    const data = await res.json();
    return data.access_token || null;
  } catch (e) { console.error('Reddit OAuth token error:', e.message); return null; }
}

async function fetchRedditSignal() {
  const items = [];
  const token = await getRedditToken();
  if (!token) {
    console.log('REDDIT_CLIENT_ID/SECRET not set (or token request failed) — skipping Reddit signal.');
    return items;
  }
  for (const sub of REDDIT_SUBS) {
    try {
      const url = `https://oauth.reddit.com/r/${sub}/top?t=week&limit=8`;
      const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'User-Agent': REDDIT_UA } });
      if (!res.ok) { console.error('Reddit fetch failed for r/' + sub + ':', res.status); continue; }
      const data = await res.json();
      (data.data?.children || []).forEach(c => {
        const p = c.data;
        if (!p) return;
        items.push({
          title: p.title,
          subreddit: sub,
          upvotes: p.ups,
          comments: p.num_comments,
          url: 'https://reddit.com' + p.permalink
        });
      });
    } catch (e) { console.error('Reddit fetch error for r/' + sub + ':', e.message); }
  }
  console.log('Reddit signal:', items.length, 'posts across', REDDIT_SUBS.length, 'subreddits.');
  return items;
}

async function fetchInstagramSignal() {
  // Instagram has no free/legal trending-content API. This uses Gemini + Google
  // Search grounding to find real, sourced web mentions of what's trending on
  // Instagram Reels right now — an honest proxy signal, never invented data.
  const prompt = `Search the web for real, currently-trending Instagram Reels or posts (this week) related to business, entrepreneurship, startups, scams, or corporate stories. Only report items you can back with a real, working source URL (a news article, blog, or aggregator that discusses the trending Reel/post) — do not guess or invent anything.\n\nFor each one found, respond in EXACTLY this block format:\n\nTITLE: <what the trending content is about>\nSOURCE: <the real URL>\n\nIf you cannot find any with real sources, return nothing.`;
  try {
    const text = await callGemini(prompt, true);
    const blocks = text.split(/\n(?=TITLE:)/i);
    const items = [];
    blocks.forEach(b => {
      const title = (b.match(/TITLE:\s*(.+)/i) || [])[1];
      const source = (b.match(/SOURCE:\s*(.+)/i) || [])[1];
      if (title && source) items.push({ title: title.trim(), url: source.trim() });
    });
    console.log('Instagram-proxy signal:', items.length, 'sourced items.');
    return items;
  } catch (e) {
    console.error('Instagram-proxy signal failed:', e.message);
    return [];
  }
}

function trimList(items, n, keyFn) {
  return items.slice(0, n).map(keyFn).join('\n') || '(none found)';
}

async function synthesizeContentResearch(yt, reddit, ig) {
  const ytBlock = trimList(yt, 30, v => `- "${v.title}" (${v.channel}, ${v.publishedAt.slice(0, 10)}) ${v.url}`);
  const redditBlock = trimList(reddit.sort((a, b) => b.upvotes - a.upvotes), 30, p => `- [r/${p.subreddit}, ${p.upvotes} upvotes, ${p.comments} comments] "${p.title}" ${p.url}`);
  const igBlock = trimList(ig, 15, i => `- "${i.title}" ${i.url}`);

  const prompt = `You are a viral-content strategist for a Hindi business-storytelling YouTube Shorts channel (faceless, AI avatar). The channel's 10 categories are: ${CATEGORIES.join(', ')}.

Below is REAL raw signal pulled just now from three platforms. Your job: find the 8-10 strongest video topic candidates by looking for overlap, momentum, and genuine relevance to this channel's niche — not just copying titles verbatim.

=== YOUTUBE (recent high-view videos matching business/company-story searches) ===
${ytBlock}

=== REDDIT (top posts this week from business-adjacent subreddits) ===
${redditBlock}

=== INSTAGRAM-ADJACENT (web-sourced mentions of trending Instagram business content) ===
${igBlock}

For each of your 8-10 picks, respond in EXACTLY this block format:

TITLE: <a punchy Hindi/Hinglish video title for THIS channel, not a copy of the source headline>
CATEGORY: <closest fit from the 10 categories above>
VIRAL_SCORE: <1-10, how likely this specific angle is to perform well as a Hindi business-storytelling Short right now>
WHY: <one line — what signal(s) above support this, e.g. "trending on 2 platforms" or "high Reddit engagement + recent YouTube spike">
PLATFORMS: <comma-separated: YouTube, Reddit, Instagram — whichever platforms actually support this pick>
SOURCE: <one real URL from the signal above that best backs this pick>

Only pick topics you can genuinely back with the signal above — do not invent a topic with no supporting evidence. If fewer than 8 topics are well-supported, return fewer rather than padding with weak picks.`;

  try {
    const text = await callGemini(prompt);
    const blocks = text.split(/\n(?=TITLE:)/i);
    const items = [];
    blocks.forEach(b => {
      const title = (b.match(/TITLE:\s*(.+)/i) || [])[1];
      const cat = (b.match(/CATEGORY:\s*(.+)/i) || [])[1];
      const score = (b.match(/VIRAL_SCORE:\s*(\d+)/i) || [])[1];
      const why = (b.match(/WHY:\s*(.+)/i) || [])[1];
      const platforms = (b.match(/PLATFORMS:\s*(.+)/i) || [])[1];
      const source = (b.match(/SOURCE:\s*(.+)/i) || [])[1];
      if (title && source) {
        items.push({
          title: title.trim(),
          cat: CATEGORIES.find(c => c.toLowerCase() === (cat || '').trim().toLowerCase()) || CATEGORIES[0],
          viralScore: Math.max(1, Math.min(10, parseInt(score, 10) || 5)),
          why: (why || '').trim(),
          platforms: (platforms || '').split(',').map(s => s.trim()).filter(Boolean),
          source: source.trim()
        });
      }
    });
    return items.sort((a, b) => b.viralScore - a.viralScore);
  } catch (e) {
    console.error('Content research synthesis failed:', e.message);
    return [];
  }
}

async function runContentResearch() {
  const [yt, reddit, ig] = await Promise.all([fetchYouTubeSignal(), fetchRedditSignal(), fetchInstagramSignal()]);
  if (!yt.length && !reddit.length && !ig.length) {
    console.log('No raw signal from any platform this run — skipping synthesis, leaving old contentResearch data as-is.');
    return;
  }
  const items = await synthesizeContentResearch(yt, reddit, ig);
  if (!items.length) { console.log('Content research synthesis returned 0 usable topics — leaving old data as-is.'); return; }
  await setDoc(doc(db, 'meta', 'contentResearch'), {
    items,
    lastRefreshed: Date.now(),
    signalCounts: { youtube: yt.length, reddit: reddit.length, instagram: ig.length }
  });
  console.log('Content research saved:', items.length, 'scored topics.');
}

async function main() {
  await replenishBacklog();
  await refreshTrending();
  await runContentResearch();
  console.log('Daily content ops complete.');
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
