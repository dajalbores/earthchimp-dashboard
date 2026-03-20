// Weekly Review Tracker
// Tracks week-to-date total, positive (4-5★), and negative (1-3★) reviews
// for US Marketplace products.
// Every Monday: saves current counts as the week's baseline.
// Any other day: shows how many new reviews came in since Monday.

require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const BASELINES_PATH = path.join(__dirname, 'baselines.json');
const LAST_WEEK_SUMMARY_PATH = path.join(__dirname, 'last-week-summary.json');

// US products to track
const TRACKING_URLS = [
  'https://www.amazon.com/dp/B09S294TGM', // Chocolate
  'https://www.amazon.com/dp/B09S2LSQ4D', // Plain & Unsweetened
  'https://www.amazon.com/dp/B09S2G3ZPP', // Plain & Unsweetened (2nd ASIN)
  'https://www.amazon.com/dp/B09S27FV5F', // Vanilla
];

// --- Helpers ---

function getMondayDate(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split('T')[0];
}

function isMonday() {
  return new Date().getDay() === 1;
}

function loadBaselines() {
  if (!fs.existsSync(BASELINES_PATH)) return {};
  return JSON.parse(fs.readFileSync(BASELINES_PATH, 'utf8'));
}

function saveBaselines(data) {
  fs.writeFileSync(BASELINES_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function extractAsin(url) {
  const match = url.match(/\/dp\/([A-Z0-9]{10})/);
  return match ? match[1] : url;
}

function loadLastWeekSummary() {
  if (!fs.existsSync(LAST_WEEK_SUMMARY_PATH)) return { weekStart: '', total: 0, rating: '4.5', currentRating: '4.5' };
  return JSON.parse(fs.readFileSync(LAST_WEEK_SUMMARY_PATH, 'utf8'));
}

function saveLastWeekSummary(data) {
  fs.writeFileSync(LAST_WEEK_SUMMARY_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// Compute overall weighted average rating from scraped products array
function computeWeightedRating(products) {
  let totalReviews = 0;
  let weightedSum = 0;
  for (const p of products) {
    const tc = p.total.current;
    if (!tc) continue;
    const avg = (5 * p.starPct[5] + 4 * p.starPct[4] + 3 * p.starPct[3] + 2 * p.starPct[2] + 1 * p.starPct[1]) / 100;
    weightedSum += avg * tc;
    totalReviews += tc;
  }
  if (!totalReviews) return '4.5';
  return (weightedSum / totalReviews).toFixed(1);
}

// Inject US summary stat blocks into dashboard (between <!-- US_SUMMARY_START/END --> markers)
function updateDashboardSummary(lastWeek, currentTotal, currentRating, productCount) {
  const indexPath = path.join(__dirname, 'index.html');
  if (!fs.existsSync(indexPath)) return;

  const delta = currentTotal - (lastWeek.total || 0);
  const deltaStr = delta >= 0 ? `+${delta.toLocaleString('en-US')}` : `${delta.toLocaleString('en-US')}`;
  const lastWeekRating = lastWeek.rating || '4.5';
  const lastWeekTotal = (lastWeek.total || 0).toLocaleString('en-US');

  const summaryHtml = `<!-- US_SUMMARY_START -->
        <div class="stat-block">
          <div class="label">Weighted Average Rating</div>
          <div class="value">${currentRating} &#9733;</div>
          <div class="sub">out of 5 stars</div>
          <div class="stat-last-week">Last week &nbsp;${lastWeekRating} &#9733;</div>
        </div>
        <div class="stat-block">
          <div class="label">Total Customer Reviews</div>
          <div class="value-row">
            <span class="value">${currentTotal.toLocaleString('en-US')}</span>
            <span class="stat-delta">${deltaStr}</span>
          </div>
          <div class="sub">across ${productCount} variants</div>
          <div class="stat-last-week">Last week &nbsp;${lastWeekTotal} reviews</div>
        </div>
        <!-- US_SUMMARY_END -->`;

  let html = fs.readFileSync(indexPath, 'utf8');
  if (html.includes('<!-- US_SUMMARY_START -->')) {
    html = html.replace(/<!-- US_SUMMARY_START -->[\s\S]*?<!-- US_SUMMARY_END -->/m, summaryHtml);
    fs.writeFileSync(indexPath, html, 'utf8');
    console.log('Dashboard US summary updated.');
  }
}

// --- Scraper ---

async function scrapeUS(url) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0',
  };

  const response = await axios.get(url, { headers, timeout: 15000 });
  const $ = cheerio.load(response.data);

  if ($('title').text().includes('Robot Check') || $('title').text().includes('CAPTCHA')) {
    throw new Error('Amazon blocked the request (CAPTCHA).');
  }

  // Product title & variant
  const title =
    $('#productTitle').text().trim() ||
    $('h1.a-size-large').first().text().trim() ||
    'Unknown';

  const variantMatch = title.match(/\(([^)]+)\)/);
  const variant = variantMatch ? variantMatch[1] : title.split('-')[0].trim();

  // Total review count
  const reviewCountText =
    $('#acrCustomerReviewText').first().text().trim() ||
    $('[data-hook="total-review-count"]').first().text().trim() ||
    '0';
  const totalCount = parseInt(reviewCountText.replace(/[^0-9]/g, ''), 10);

  // Star rating histogram — Amazon uses aria-label: "78 percent of reviews have 5 stars"
  const starPct = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };

  $('#histogramTable a[aria-label]').each((_, el) => {
    const label = $(el).attr('aria-label') || '';
    const match = label.match(/(\d+)\s*percent of reviews have (\d)\s*star/i);
    if (match) {
      starPct[parseInt(match[2])] = parseInt(match[1], 10);
    }
  });

  // Calculate counts from percentages
  const positiveCount = Math.round(totalCount * (starPct[5] + starPct[4]) / 100);
  const negativeCount = Math.round(totalCount * (starPct[3] + starPct[2] + starPct[1]) / 100);

  return { variant, totalCount, positiveCount, negativeCount, starPct };
}

// --- Main tracker ---

async function trackProduct(url) {
  const asin = extractAsin(url);
  const currentWeek = getMondayDate();
  const baselines = loadBaselines();

  const info = await scrapeUS(url);
  const { variant, totalCount, positiveCount, negativeCount } = info;

  if (isNaN(totalCount)) throw new Error(`Could not parse review count for ${asin}`);

  const needsNewBaseline =
    isMonday() || !baselines[asin] || baselines[asin].weekStart !== currentWeek;

  if (needsNewBaseline) {
    baselines[asin] = {
      weekStart: currentWeek,
      totalCount,
      positiveCount,
      negativeCount,
    };
    saveBaselines(baselines);
  }

  const bl = baselines[asin];

  return {
    asin,
    url,
    variant,
    weekStart: bl.weekStart,
    total:    { baseline: bl.totalCount,    current: totalCount,    wtd: totalCount    - bl.totalCount },
    positive: { baseline: bl.positiveCount, current: positiveCount, wtd: positiveCount - bl.positiveCount },
    negative: { baseline: bl.negativeCount, current: negativeCount, wtd: negativeCount - bl.negativeCount },
    starPct: info.starPct,
  };
}

function fmt(n) { return n.toLocaleString('en-US'); }
function wtd(n) { return n >= 0 ? `+${fmt(n)}` : `${fmt(n)}`; }

// --- Inject WTD section into dashboard ---
function updateDashboardWTD(report) {
  const indexPath = path.join(__dirname, 'index.html');
  if (!fs.existsSync(indexPath)) return;

  const { weekStart, scrapedAt, products, summary } = report;

  const rowsHtml = products.map(p => `
        <tr>
          <td>${p.variant}</td>
          <td class="num">${wtd(p.total.wtd)}</td>
          <td class="num pos">${wtd(p.positive.wtd)}</td>
          <td class="num neg">${wtd(p.negative.wtd)}</td>
        </tr>`).join('');

  const wtdHtml = `<!-- WTD_START -->
  <div class="marketplace wtd-section">
    <div class="marketplace-header">
      <h2>US — Week-to-Date Reviews</h2>
      <span class="badge wtd-badge">Since Mon ${weekStart}</span>
    </div>
    <table class="wtd-table">
      <thead>
        <tr>
          <th>Variant</th>
          <th>WTD Total</th>
          <th>Positive &#9733;&#9733;&#9733;&#9733;&#9733; (4-5★)</th>
          <th>Negative &#9734;&#9734;&#9734; (1-3★)</th>
        </tr>
      </thead>
      <tbody>
${rowsHtml}
        <tr class="wtd-total-row">
          <td><strong>TOTAL</strong></td>
          <td class="num"><strong>${wtd(summary.total.wtd)}</strong></td>
          <td class="num pos"><strong>${wtd(summary.positive.wtd)}</strong></td>
          <td class="num neg"><strong>${wtd(summary.negative.wtd)}</strong></td>
        </tr>
      </tbody>
    </table>
    <p class="wtd-note">Last updated: ${scrapedAt} (PHT)</p>
  </div>
  <!-- WTD_END -->`;

  const wtdStyles = `
    /* WTD Section */
    .wtd-section { margin-bottom: 56px; }

    .badge.wtd-badge { background: #805ad5; }

    .wtd-table {
      width: 100%;
      border-collapse: collapse;
      background: white;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0,0,0,0.07);
    }

    .wtd-table th {
      background: #2d3748;
      color: white;
      padding: 14px 20px;
      text-align: left;
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .wtd-table td {
      padding: 14px 20px;
      border-bottom: 1px solid #e2e8f0;
      font-size: 0.95rem;
      color: #2d3748;
    }

    .wtd-table tr:last-child td { border-bottom: none; }

    .wtd-table tr:hover td { background: #f7fafc; }

    .wtd-table .num { text-align: right; font-weight: 600; font-size: 1rem; }

    .wtd-table .pos { color: #276749; }
    .wtd-table .neg { color: #c53030; }

    .wtd-total-row td {
      background: #f0f4f8;
      font-size: 1rem;
    }

    .wtd-note {
      margin-top: 10px;
      font-size: 0.78rem;
      color: #a0aec0;
      text-align: right;
    }`;

  let html = fs.readFileSync(indexPath, 'utf8');

  // Inject styles once (before </style>)
  if (!html.includes('/* WTD Section */')) {
    html = html.replace('  </style>', wtdStyles + '\n  </style>');
  }

  // Replace existing WTD section or insert before UK marketplace
  if (html.includes('<!-- WTD_START -->')) {
    html = html.replace(/<!-- WTD_START -->[\s\S]*?<!-- WTD_END -->/m, wtdHtml);
  } else {
    html = html.replace('<!-- ===== UK MARKETPLACE =====', wtdHtml + '\n\n  <!-- ===== UK MARKETPLACE =====');
  }

  fs.writeFileSync(indexPath, html, 'utf8');
  console.log('Dashboard updated with WTD section.');
}

async function main() {
  const now = new Date();
  const today = now.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'full' });
  const todayISO = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Manila' }))
    .toISOString().split('T')[0];

  console.log(`\nUS Marketplace — Week-to-Date Review Tracker`);
  console.log(`Date       : ${today}`);
  console.log(`Week of    : ${getMondayDate()}\n`);
  console.log('='.repeat(62));

  // On Monday, snapshot old baselines before they get overwritten
  let prevTotal = 0;
  let prevWeekStart = null;
  if (isMonday()) {
    const oldBaselines = loadBaselines();
    for (const url of TRACKING_URLS) {
      const asin = extractAsin(url);
      if (oldBaselines[asin]) prevTotal += oldBaselines[asin].totalCount || 0;
    }
    const firstKey = Object.keys(oldBaselines)[0];
    if (firstKey) prevWeekStart = oldBaselines[firstKey].weekStart;
  }

  const totals = { total: { b: 0, c: 0 }, positive: { b: 0, c: 0 }, negative: { b: 0, c: 0 } };
  const products = [];

  for (const url of TRACKING_URLS) {
    try {
      const r = await trackProduct(url);

      console.log(`\nVariant   : ${r.variant}  (ASIN: ${r.asin})`);
      console.log(`Star %    : 5★ ${r.starPct[5]}%  4★ ${r.starPct[4]}%  3★ ${r.starPct[3]}%  2★ ${r.starPct[2]}%  1★ ${r.starPct[1]}%`);
      console.log(`          ${'Baseline (Mon)'.padEnd(18)}${'Current'.padEnd(14)}WTD`);
      console.log(`Total     : ${fmt(r.total.baseline).padEnd(18)}${fmt(r.total.current).padEnd(14)}${wtd(r.total.wtd)}`);
      console.log(`Positive  : ${fmt(r.positive.baseline).padEnd(18)}${fmt(r.positive.current).padEnd(14)}${wtd(r.positive.wtd)}  (4-5★)`);
      console.log(`Negative  : ${fmt(r.negative.baseline).padEnd(18)}${fmt(r.negative.current).padEnd(14)}${wtd(r.negative.wtd)}  (1-3★)`);

      totals.total.b    += r.total.baseline;    totals.total.c    += r.total.current;
      totals.positive.b += r.positive.baseline; totals.positive.c += r.positive.current;
      totals.negative.b += r.negative.baseline; totals.negative.c += r.negative.current;

      products.push({
        asin: r.asin,
        variant: r.variant,
        starPct: r.starPct,
        total:    r.total,
        positive: r.positive,
        negative: r.negative,
      });
    } catch (err) {
      console.error(`\nFailed for ${url}: ${err.message}`);
    }
  }

  const summary = {
    total:    { baseline: totals.total.b,    current: totals.total.c,    wtd: totals.total.c    - totals.total.b },
    positive: { baseline: totals.positive.b, current: totals.positive.c, wtd: totals.positive.c - totals.positive.b },
    negative: { baseline: totals.negative.b, current: totals.negative.c, wtd: totals.negative.c - totals.negative.b },
  };

  console.log('\n' + '='.repeat(62));
  console.log(`\nUS TOTAL — Week-to-Date Summary`);
  console.log(`          ${'Baseline (Mon)'.padEnd(18)}${'Current'.padEnd(14)}WTD`);
  console.log(`Total     : ${fmt(summary.total.baseline).padEnd(18)}${fmt(summary.total.current).padEnd(14)}${wtd(summary.total.wtd)}`);
  console.log(`Positive  : ${fmt(summary.positive.baseline).padEnd(18)}${fmt(summary.positive.current).padEnd(14)}${wtd(summary.positive.wtd)}  (4-5★)`);
  console.log(`Negative  : ${fmt(summary.negative.baseline).padEnd(18)}${fmt(summary.negative.current).padEnd(14)}${wtd(summary.negative.wtd)}  (1-3★)\n`);

  // Save results to weekly-report.json for dashboard display
  const report = {
    scrapedAt: today,
    scrapedDate: todayISO,
    weekStart: getMondayDate(),
    products,
    summary,
  };
  fs.writeFileSync(path.join(__dirname, 'weekly-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('Report saved to weekly-report.json');

  updateDashboardWTD(report);

  // Update US summary panel (current totals + last-week comparison)
  const currentRating = computeWeightedRating(products);
  const currentTotal = summary.total.current;
  const lastWeek = loadLastWeekSummary();

  if (isMonday() && prevTotal > 0) {
    // Promote this week's snapshot to "last week" and start fresh
    const newLastWeek = {
      weekStart: prevWeekStart || lastWeek.weekStart,
      total: prevTotal,
      rating: lastWeek.currentRating || lastWeek.rating,
      currentRating,
    };
    saveLastWeekSummary(newLastWeek);
    updateDashboardSummary(newLastWeek, currentTotal, currentRating, products.length);
  } else {
    // Not Monday — just refresh current rating; keep last-week values unchanged
    const updated = { ...lastWeek, currentRating };
    saveLastWeekSummary(updated);
    updateDashboardSummary(updated, currentTotal, currentRating, products.length);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
