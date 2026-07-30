// Content Command Center — Daily Content Ops
// Runs server-side via GitHub Actions (never in the browser).
// Uses the GEMINI_API_KEY / GEMINI_API_KEY1 repo secrets to:
//   1. Auto-replenish the Topic Backlog (meta/topicsList) up to 100 active topics.
//   2. Refresh Trending Topics (meta/trending) using Google Search grounding.
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

async function main() {
  await replenishBacklog();
  await refreshTrending();
  console.log('Daily content ops complete.');
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
