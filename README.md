# zerodig

**Advanced YouTube Search.** A client-side, single-page interface to the **YouTube Data API v3** that exposes
**every filter the API offers** in one place. Search videos, channels and
playlists; narrow by date, region, language, duration, definition, license,
category and more; then refine locally by views, likes, comments and length.
Black/white terminal aesthetic. No server, no build step, no tracking.

### ▶ Live site: <https://flazeiguess.github.io/zerodig/>

Open it, paste a free YouTube Data API key, and search. Everything runs in your
browser; nothing is stored on a server.

---

## What you can filter by

**Native `search.list` parameters (server-side):**

| Filter | Options |
| --- | --- |
| query `q` | free text with `"exact phrase"`, `a|b` (OR), `-exclude` |
| type | video · channel · playlist · all |
| order | relevance · date · rating · view count · title · video count |
| published after / before | any date window |
| region · language | ISO country + language codes |
| safe search | moderate · none · strict |
| within channel | restrict to a channel id |
| duration | short (<4m) · medium (4-20m) · long (>20m) |
| definition | HD · SD |
| dimension | 2D · 3D |
| captions | has captions · none |
| license | standard YouTube · Creative Commons |
| video type | movie · episode |
| category | Music, Gaming, Education, News … |
| event | live · upcoming · completed |
| embeddable · syndicated · paid promotion | yes / any |
| location + radius | geo search around a lat,lng |
| results per page | 1-50 |

**Local post-filters (client-side, what the API can't do):**

- min / max **views**
- min **likes**
- min / max **length** (seconds)
- **re-sort** results by views ↑/↓, likes, newest, oldest, longest, shortest

## How it works

The API can't filter or sort by view count, likes or exact length, so the app
runs a two-stage workflow, client-side:

1. **`search.list`** with your native filters (100 quota units / page, up to 50 ids).
2. **Enrich** each page depending on result type: `videos.list`
   (statistics + contentDetails), `channels.list` (subscribers, video count) or
   `playlists.list` (item count), 1 unit each.
3. **Filter & sort** the enriched results locally by views, likes and length.
4. **Auto-page**: follow `nextPageToken` until it hits your *dig depth* or
   *stop-after* target. **Load more** continues from where it stopped.

The live console prints every page fetched and the running quota cost.

## Quick start

1. Open the [live site](https://flazeiguess.github.io/zerodig/).
2. Get a free API key (below) and hit **Save**.
3. Type a query, pick a type, tune filters, and hit **Search**.

## Get an API key (free)

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project, then **APIs & Services -> Library** -> enable **YouTube Data API v3**.
3. **Credentials -> Create credentials -> API key.**
4. Paste it into the app and hit **Save** (stored in your browser's `localStorage`).

### Key security

Because this is a **static site, the key sits in your browser and travels only to
Google**, but anyone who opens the deployed page and views the network tab could
read it while you use it. Protect it:

- **Application restriction** -> *HTTP referrers* -> add the Pages domain:
  `https://flazeiguess.github.io/zerodig/*`
- **API restriction** -> restrict the key to **YouTube Data API v3** only.
- Daily quota is **10,000 units/day**. A `search` page is 100 units + up to 3 to
  enrich; a depth-3 run is roughly **309 units**. The status bar tracks today's usage.

If you ever want the key fully hidden, move the fetch calls behind a tiny proxy
(Cloudflare Worker / Django) that holds the key server-side. The frontend logic
stays identical.

## Run locally

Plain HTML/CSS/JS. Any static server works:

```bash
python -m http.server 8000
# or
npx serve .
```

Then open <http://localhost:8000>.

## Deploy (GitHub Pages)

Already published to Pages from `main` at
<https://flazeiguess.github.io/zerodig/>. To reproduce on a fork:

1. Push the files to a repo.
2. **Settings -> Pages -> Source: Deploy from a branch -> `main` / `root`.**
3. The included `.nojekyll` file serves everything as-is.
4. Add your own Pages domain to the API key's referrer restriction (above).

> Assets are versioned with a `?v=` query so a redeploy busts the browser cache.
> Bump it (e.g. `app.js?v=3`) in `index.html` when you ship changes.

## Files

| File | Role |
| --- | --- |
| `index.html` | structure |
| `tokens.css` | design tokens (colour, type, space, motion) |
| `style.css` | terminal styling |
| `app.js` | search, enrichment, filtering, paging |
| `.nojekyll` | serve raw on GitHub Pages |

## Notes

- Video-only attributes (duration, definition, category …) apply to `type = video`
  and hide for channel / playlist searches.
- View / like / length filters apply to video results; channels and playlists pass
  through unfiltered.
- Videos with hidden statistics show `n/a` and are excluded when a numeric view
  filter is active (they can't be verified).
- Everything is grayscale on purpose except the thumbnails, which show in full colour.
