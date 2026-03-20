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

async function main() {
  const today = new Date().toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'full',
  });

  console.log(`\nUS Marketplace — Week-to-Date Review Tracker`);
  console.log(`Date       : ${today}`);
  console.log(`Week of    : ${getMondayDate()}\n`);
  console.log('='.repeat(62));

  const totals = { total: { b: 0, c: 0 }, positive: { b: 0, c: 0 }, negative: { b: 0, c: 0 } };

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
    } catch (err) {
      console.error(`\nFailed for ${url}: ${err.message}`);
    }
  }

  console.log('\n' + '='.repeat(62));
  console.log(`\nUS TOTAL — Week-to-Date Summary`);
  console.log(`          ${'Baseline (Mon)'.padEnd(18)}${'Current'.padEnd(14)}WTD`);
  console.log(`Total     : ${fmt(totals.total.b).padEnd(18)}${fmt(totals.total.c).padEnd(14)}${wtd(totals.total.c - totals.total.b)}`);
  console.log(`Positive  : ${fmt(totals.positive.b).padEnd(18)}${fmt(totals.positive.c).padEnd(14)}${wtd(totals.positive.c - totals.positive.b)}  (4-5★)`);
  console.log(`Negative  : ${fmt(totals.negative.b).padEnd(18)}${fmt(totals.negative.c).padEnd(14)}${wtd(totals.negative.c - totals.negative.b)}  (1-3★)\n`);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
