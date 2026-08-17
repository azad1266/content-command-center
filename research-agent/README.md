# AI Research Agent — Notion Automation

Weekly automation: Reddit + Hacker News + Product Hunt se AI tools/tricks khojta hai,
Groq se content-ready hooks banata hai, aur seedha tumhare Notion database mein daal deta hai.
Har Sunday 10:00 AM IST apne aap chalega (GitHub Actions cron).

## Setup (ek baar karna hai)

### 1. Secrets add karo
Repo -> Settings -> Secrets and variables -> Actions -> "New repository secret":

| Secret name | Value |
|---|---|
| `NOTION_TOKEN` | Tumhara Notion integration secret (jo `ntn_...` se start hota hai) |
| `NOTION_PARENT_PAGE_ID` | `3134c3b2-9033-8085-bc3e-e5aec364ac7e` (Grit-Aditya page — sirf first run ke liye chahiye) |
| `GROQ_API_KEY` | Wahi Groq key jo x-auto-poster mein use karte ho |
| `TELEGRAM_BOT_TOKEN` *(optional)* | Wahi bot token jo x-auto-poster mein use karte ho |
| `TELEGRAM_CHAT_ID` *(optional)* | Wahi chat ID |

**Zaroori:** Grit-Aditya page pe Notion mein jaake top-right "..." -> Connections -> apni integration ko share/add karna mat bhoolna (agar pehle se nahi kiya), warna API access denied milega.

### 2. Pehli baar manually chalao
GitHub repo -> Actions tab -> "Weekly AI Research Agent" -> "Run workflow" button se manually trigger karo.

Iske logs mein ek line milegi jaisi:
```
::notice::Created new database. SAVE THIS as the NOTION_DATABASE_ID secret -> 2ab34cd5-...
```

Us ID ko copy karke ek naya secret bana do: `NOTION_DATABASE_ID`. Yeh step zaroori hai — warna agli baar phir se naya database ban jaayega instead of usi mein add karne ke.

### 3. Ab it's automatic
Har Sunday 10 AM IST apne aap chalega. Agar Telegram secrets diye hain toh summary message bhi aayega.

## Notion database ke columns
- **Name** — tool/trend ka naam
- **Use Case** — 1 line mein kya kaam aata hai
- **Hook Angle** — content ke liye ready hook line
- **Category** — AI Tool / AI Trick-Prompt / News-Trend
- **Source** — original link
- **Tested** — checkbox, khud verify karne ke baad tick karo
- **Date Added** — auto-filled

## Note
- Sources sab free hain (Reddit, Hacker News, Product Hunt RSS) — koi extra API key nahi chahiye.
- Agar kabhi Groq response format change ho ya parsing fail ho, Action logs mein `[warn]` lines dikhengi — wahan se debug ho jaayega.
- Notion API version header (`2026-03-11`) file ke top mein hai — agar Notion future mein version deprecate kare toh yahi line update karni hogi.
