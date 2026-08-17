"""
Notion Research Automation Agent
---------------------------------
Weekly job: scans AI-tools sources (Reddit, Hacker News, Product Hunt RSS),
uses Groq (same model as x-auto-poster) to turn raw items into content-ready
entries, and writes them straight into a Notion database.

Run via GitHub Actions (see .github/workflows/notion_research_agent.yml).

Required secrets (GitHub repo -> Settings -> Secrets and variables -> Actions):
  NOTION_TOKEN            - Notion internal integration secret (starts with ntn_)
  NOTION_PARENT_PAGE_ID   - Notion page the tracker DB should live under (only
                            needed for the very first run, until the DB exists)
  GROQ_API_KEY            - same Groq key used in x-auto-poster

Optional secrets:
  NOTION_DATABASE_ID      - set this AFTER the first run (grab it from the
                            Action log) so the script reuses the same
                            database instead of creating a new one each week
  TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID - if set, sends a short summary
                            message after each run (same bot as x-auto-poster)
"""
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

NOTION_VERSION = "2026-03-11"
DB_TITLE = "AI Tools Research Tracker"
GROQ_MODEL = "llama-3.3-70b-versatile"

NOTION_TOKEN = os.environ["NOTION_TOKEN"]
GROQ_API_KEY = os.environ["GROQ_API_KEY"]
PARENT_PAGE_ID = os.environ.get("NOTION_PARENT_PAGE_ID")
DATABASE_ID = os.environ.get("NOTION_DATABASE_ID")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")

NOTION_HEADERS = {
    "Authorization": f"Bearer {NOTION_TOKEN}",
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
}


# ---------- Notion setup ----------

def create_database():
    if not PARENT_PAGE_ID:
        print("ERROR: NOTION_PARENT_PAGE_ID secret is required for the first run "
              "(the page under which the tracker database will be created).")
        sys.exit(1)

    payload = {
        "parent": {"type": "page_id", "page_id": PARENT_PAGE_ID},
        "title": [{"type": "text", "text": {"content": DB_TITLE}}],
        "initial_data_source": {
            "properties": {
                "Name": {"type": "title", "title": {}},
                "Use Case": {"type": "rich_text", "rich_text": {}},
                "Hook Angle": {"type": "rich_text", "rich_text": {}},
                "Source": {"type": "url", "url": {}},
                "Category": {
                    "type": "select",
                    "select": {
                        "options": [
                            {"name": "AI Tool", "color": "blue"},
                            {"name": "AI Trick/Prompt", "color": "purple"},
                            {"name": "News/Trend", "color": "orange"},
                        ]
                    },
                },
                "Tested": {"type": "checkbox", "checkbox": {}},
                "Date Added": {"type": "date", "date": {}},
            }
        },
    }
    r = requests.post("https://api.notion.com/v1/databases", headers=NOTION_HEADERS, json=payload, timeout=30)
    r.raise_for_status()
    data = r.json()
    db_id = data["id"]
    ds_id = data["data_sources"][0]["id"]
    print(f"::notice::Created new database. SAVE THIS as the NOTION_DATABASE_ID secret -> {db_id}")
    return db_id, ds_id


def get_data_source_id(db_id):
    r = requests.get(f"https://api.notion.com/v1/databases/{db_id}", headers=NOTION_HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()["data_sources"][0]["id"]


# ---------- Research sources (all free, no keys needed) ----------

def fetch_reddit(subs=("artificial", "ChatGPT", "SideProject", "OpenAI"), limit=10):
    items = []
    headers = {"User-Agent": "research-agent/1.0 (by aditya)"}
    for sub in subs:
        try:
            r = requests.get(
                f"https://www.reddit.com/r/{sub}/top.json?limit={limit}&t=week",
                headers=headers, timeout=20,
            )
            r.raise_for_status()
            for post in r.json()["data"]["children"]:
                d = post["data"]
                items.append({
                    "title": d.get("title", ""),
                    "url": f"https://reddit.com{d.get('permalink', '')}",
                    "score": d.get("score", 0),
                })
        except Exception as e:
            print(f"[warn] Reddit fetch failed for r/{sub}: {e}")
    return items


def fetch_hackernews(query="AI tool", days=7):
    since = int((datetime.now(timezone.utc) - timedelta(days=days)).timestamp())
    items = []
    try:
        r = requests.get(
            "http://hn.algolia.com/api/v1/search_by_date",
            params={"query": query, "tags": "story", "numericFilters": f"created_at_i>{since}"},
            timeout=20,
        )
        r.raise_for_status()
        for hit in r.json().get("hits", [])[:15]:
            items.append({
                "title": hit.get("title") or "",
                "url": hit.get("url") or f"https://news.ycombinator.com/item?id={hit.get('objectID')}",
                "score": hit.get("points", 0),
            })
    except Exception as e:
        print(f"[warn] Hacker News fetch failed: {e}")
    return items


def fetch_producthunt_rss():
    import feedparser
    items = []
    try:
        feed = feedparser.parse("https://www.producthunt.com/feed?category=artificial-intelligence")
        for entry in feed.entries[:15]:
            items.append({
                "title": entry.get("title", ""),
                "url": entry.get("link", ""),
                "score": 0,
            })
    except Exception as e:
        print(f"[warn] Product Hunt RSS fetch failed: {e}")
    return items


# ---------- Groq: raw items -> content-ready entries ----------

def groq_extract(raw_items):
    if not raw_items:
        return []
    trimmed = [it for it in raw_items if it.get("title")][:40]
    listing = "\n".join(f"{i + 1}. {it['title']} ({it['url']})" for i, it in enumerate(trimmed))

    prompt = f"""You are a content researcher for a Hinglish (Hindi-English) creator who posts
Instagram carousels and X/Twitter threads about AI tools & tricks for Indian students and
side-hustlers.

From the raw list below, pick the 15 most genuinely useful, non-duplicate, content-worthy
items (skip pure discussion/drama posts, pick actual tools/tricks/launches/trends).
For each, return a JSON object with:
  "name": short tool/trend name
  "use_case": one line - what it does / why someone would use it
  "hook_angle": one punchy line - a content hook for a Hinglish carousel or thread
  "category": one of "AI Tool", "AI Trick/Prompt", "News/Trend"
  "source_url": the original URL from the list

Raw items:
{listing}

Return ONLY a JSON array of these objects, nothing else.
"""
    r = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
        json={
            "model": GROQ_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.4,
            "max_tokens": 3000,
        },
        timeout=60,
    )
    r.raise_for_status()
    content = r.json()["choices"][0]["message"]["content"]
    match = re.search(r"\[.*\]", content, re.DOTALL)
    if not match:
        print(f"[warn] Groq did not return a JSON array. Raw response: {content[:500]}")
        return []
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError as e:
        print(f"[warn] Could not parse Groq JSON: {e}")
        return []


# ---------- Write to Notion ----------

def add_to_notion(data_source_id, entry):
    payload = {
        "parent": {"type": "data_source_id", "data_source_id": data_source_id},
        "properties": {
            "Name": {"title": [{"type": "text", "text": {"content": str(entry.get("name", "Untitled"))[:200]}}]},
            "Use Case": {"rich_text": [{"type": "text", "text": {"content": str(entry.get("use_case", ""))[:2000]}}]},
            "Hook Angle": {"rich_text": [{"type": "text", "text": {"content": str(entry.get("hook_angle", ""))[:2000]}}]},
            "Category": {"select": {"name": entry.get("category") or "AI Tool"}},
            "Tested": {"checkbox": False},
            "Date Added": {"date": {"start": datetime.now(timezone.utc).date().isoformat()}},
        },
    }
    if entry.get("source_url"):
        payload["properties"]["Source"] = {"url": entry["source_url"]}

    r = requests.post("https://api.notion.com/v1/pages", headers=NOTION_HEADERS, json=payload, timeout=30)
    if r.status_code >= 300:
        print(f"[warn] Failed to add '{entry.get('name')}': {r.status_code} {r.text[:300]}")
        return False
    return True


def notify_telegram(count, db_id):
    if not (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID):
        return
    db_url = f"https://www.notion.so/{db_id.replace('-', '')}"
    text = f"Research Agent: {count} naye AI tools/tricks Notion tracker mein add ho gaye.\n{db_url}"
    try:
        requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={"chat_id": TELEGRAM_CHAT_ID, "text": text},
            timeout=15,
        )
    except Exception as e:
        print(f"[warn] Telegram notify failed: {e}")


def main():
    global DATABASE_ID
    if DATABASE_ID:
        data_source_id = get_data_source_id(DATABASE_ID)
        print(f"Using existing database {DATABASE_ID}")
    else:
        DATABASE_ID, data_source_id = create_database()

    raw = []
    raw += fetch_reddit()
    raw += fetch_hackernews()
    raw += fetch_producthunt_rss()
    print(f"Collected {len(raw)} raw items from sources")

    entries = groq_extract(raw)
    print(f"Groq extracted {len(entries)} content-ready entries")

    added = 0
    for entry in entries:
        if add_to_notion(data_source_id, entry):
            added += 1
        time.sleep(0.4)

    notify_telegram(added, DATABASE_ID)
    print(f"Done. Added {added} new entries to database {DATABASE_ID}")


if __name__ == "__main__":
    main()
