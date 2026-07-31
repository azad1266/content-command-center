// Content Command Center — Weekly Analytics
// Runs server-side via GitHub Actions, once a week.
// For every posted topic (donePosted=true) with a YouTube Shorts URL, pulls real
// view/like/comment counts from the YouTube Data API, saves them on the topic doc,
// and rolls them up into meta/performanceStats (avg views per category). That
// aggregate is read by daily-content-ops.mjs's Content Research synthesis prompt,
// so future viral-score judgments are grounded in what has ACTUALLY worked for this
// channel — not just external signal. Requires YOUTUBE_API_KEY (same key already
// used for Content Research's YouTube signal) — if unset, the run exits quietly.

import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, getDoc, getDocs, collection } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyAgTawBW7-xwxgCRQ4S4eJaCB-aTsEm9rE",
  authDomain: "addy-content-machine.firebaseapp.com",
  projectId: "addy-content-machine",
  storageBucket: "addy-content-machine.firebasestorage.app",
  messagingSenderId: "935601887728",
  appId: "1:935601887728:web:ba320d87e9e88ae9f2e535",
  measurementId: "G-JM9T9CLHMX"
};

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

function extractVideoId(url) {
  if (!url) return null;
  const patterns = [
    /shorts\/([a-zA-Z0-9_-]{6,})/,
    /youtu\.be\/([a-zA-Z0-9_-]{6,})/,
    /[?&]v=([a-zA-Z0-9_-]{6,})/
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  if (!YOUTUBE_API_KEY) {
    console.log('YOUTUBE_API_KEY not set — skipping weekly analytics entirely.');
    return;
  }

  const topicsSnap = await getDocs(collection(db, 'topics'));
  const topicsListDoc = await getDoc(doc(db, 'meta', 'topicsList'));
  const catById = {};
  if (topicsListDoc.exists()) {
    (topicsListDoc.data().topics || []).forEach(t => { catById[String(t.id)] = t.cat; });
  }

  const posted = [];
  topicsSnap.forEach(d => {
    const data = d.data();
    if (data.donePosted && data.shortsUrl) {
      const vid = extractVideoId(data.shortsUrl);
      if (vid) posted.push({ tid: d.id, vid, cat: catById[d.id] || 'Unknown' });
    }
  });

  if (!posted.length) {
    console.log('No posted topics with a YouTube Shorts URL yet — nothing to fetch.');
    return;
  }
  console.log('Found', posted.length, 'posted videos to check.');

  const statsByVid = {};
  for (const group of chunk(posted, 50)) {
    const ids = group.map(g => g.vid).join(',');
    try {
      const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids}&key=${YOUTUBE_API_KEY}`;
      const res = await fetch(url);
      if (!res.ok) { console.error('YouTube stats fetch failed:', res.status, (await res.text()).slice(0, 200)); continue; }
      const data = await res.json();
      (data.items || []).forEach(v => {
        statsByVid[v.id] = {
          views: parseInt(v.statistics?.viewCount || '0', 10),
          likes: parseInt(v.statistics?.likeCount || '0', 10),
          comments: parseInt(v.statistics?.commentCount || '0', 10)
        };
      });
    } catch (e) { console.error('YouTube stats fetch error:', e.message); }
  }

  const byCategory = {};
  let updated = 0;
  for (const p of posted) {
    const stats = statsByVid[p.vid];
    if (!stats) continue;
    await setDoc(doc(db, 'topics', p.tid), { stats: { ...stats, fetchedAt: Date.now() } }, { merge: true });
    updated++;
    if (!byCategory[p.cat]) byCategory[p.cat] = { totalViews: 0, count: 0 };
    byCategory[p.cat].totalViews += stats.views;
    byCategory[p.cat].count += 1;
  }

  const byCategoryAvg = {};
  Object.entries(byCategory).forEach(([cat, v]) => {
    byCategoryAvg[cat] = { avgViews: v.totalViews / v.count, count: v.count };
  });

  await setDoc(doc(db, 'meta', 'performanceStats'), { byCategory: byCategoryAvg, updatedAt: Date.now() });
  console.log('Updated stats for', updated, 'video(s). Category performance saved:', JSON.stringify(byCategoryAvg));
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
