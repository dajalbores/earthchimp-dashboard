# EarthChimp Marketplace Dashboard

Automated dashboard that tracks Amazon product ratings and customer reviews across the US, UK, and DE marketplaces. Updates daily and publishes to Netlify.

---

## What This Does

### 1. Ratings Scraper (`Review Reports/amazon-scraper.js`)
Scrapes Amazon product pages across three marketplaces and updates the dashboard with the latest star ratings and review counts.

- **US** — uses direct HTTP requests (Axios + Cheerio)
- **UK / DE** — uses ScraperAPI to bypass geo-restrictions
- Tracks: star rating, total review count, week-over-week delta
- Writes results directly into `index.html`

### 2. Weekly Tracker (`Review Reports/weekly-tracker.js`)
Compares current ratings against last week's baseline and calculates changes.

- Reads from `Review Reports/baselines.json` (stored snapshots)
- Outputs a summary to `Review Reports/weekly-report.json`
- Updates the Week-to-Date section in the dashboard

### 3. GitHub Actions (Automated Schedule)
Two workflows run automatically — no manual action needed.

| Workflow | Schedule | What it runs |
|---|---|---|
| `scrape.yml` | Every Monday 8:00 AM PHT | Scraper + weekly tracker |
| `daily-tracker.yml` | Every day 8:00 AM PHT | Weekly tracker only |

Both workflows commit any changes back to the repo, which triggers an automatic Netlify deploy.

### 4. Dashboard (`index.html`)
A single-page HTML dashboard hosted on Netlify with two tabs:

- **Dashboard tab** — ratings cards and summary stats for US, UK, and DE marketplaces
- **Reviews tab** — filterable, searchable table of Seller Central customer reviews with click-to-expand modal

---

## Customer Reviews Workflow

Since Seller Central reviews cannot be scraped automatically, they are added manually:

1. Screenshot the reviews pages in Amazon Seller Central
2. Upload screenshots to Claude Chat for text extraction
3. Paste the extracted text into Claude Code
4. Save output as `.txt` files in the appropriate marketplace folder under `Reviews/`
5. Update the reviews data array in `index.html`

### Reviews Folder Structure
```
Reviews/
├── US Reviews/       ← Amazon.com Seller Central reviews
│   ├── reviews-page-1.txt
│   └── reviews-page-2.txt
├── UK Reviews/       ← Amazon.co.uk Seller Central reviews
└── DE Reviews/       ← Amazon.de Seller Central reviews
```

---

## Tech Stack

- **Node.js** — scraper and tracker scripts
- **Axios + Cheerio** — HTML fetching and parsing
- **ScraperAPI** — proxy service for UK/DE Amazon pages
- **GitHub Actions** — scheduled automation
- **Netlify** — dashboard hosting (auto-deploys on every push to `main`)

---

## Environment Variables

| Variable | Where | Purpose |
|---|---|---|
| `SCRAPER_API_KEY` | `.env` (local) / GitHub Secret | ScraperAPI key for UK/DE scraping |

---

## Local Development

```bash
# Install dependencies
npm install

# Run scraper manually
node "Review Reports/amazon-scraper.js"

# Run weekly tracker manually
node "Review Reports/weekly-tracker.js"
```
