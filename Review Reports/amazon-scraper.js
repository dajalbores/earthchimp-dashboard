// Amazon Product Rating Scraper
// Scrapes US/UK/DE Amazon listings and patches the ratings/counts in index.html
// using HTML comment markers — does NOT regenerate the whole file.

const axios  = require('axios');
const cheerio = require('cheerio');
const fs     = require('fs');
const path   = require('path');

require('dotenv').config();
const SCRAPER_API_KEY  = process.env.SCRAPER_API_KEY || 'c595fd63c5eae8f8edd9d570631860e1';
const DASHBOARD_PATH   = path.join(__dirname, '..', 'index.html');
const BASELINES_PATH   = path.join(__dirname, 'scraper-baselines.json');
const LAST_WEEK_PATH   = path.join(__dirname, 'scraper-last-week.json');

// ─── ASIN → variant name map (overrides extracted title) ─────────────────────
// Needed because Amazon product title parentheticals don't always contain flavor names.

const ASIN_VARIANT = {
  // US
  'B09S294TGM': 'Chocolate',
  'B09S2LSQ4D': 'Plain & Unsweetened',
  'B09S2G3ZPP': 'Plain & Unsweetened',
  'B09S27FV5F': 'Vanilla',
  // UK
  'B081VRSGWF': 'Chocolate',
  'B07YV7Z931': 'Chocolate',
  'B09S8VY9HY': 'Vanilla',
  'B09S8LT67H': 'Vanilla',
  'B083XZXVX7': 'Boho',
  'B07MQBK4W9': 'Boho',
  // DE (no overlap with UK ASINs to avoid overwriting UK variant names)
  'B079TP1P3V': 'EarthChamp',
  'B07GR9YY6X': 'EarthChamp',
  'B09S8RQ73K': 'EarthChamp',
  'B083XNPSH1': 'EarthChamp',
};

// ─── Scrapers ────────────────────────────────────────────────────────────────

async function scrapeWithScraperAPI(url) {
  const countryCode = url.includes('amazon.de') ? 'de'
    : url.includes('amazon.co.uk') ? 'gb' : 'us';
  const scraperUrl  = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&country_code=${countryCode}&render=true`;
  const response    = await axios.get(scraperUrl, { timeout: 60000 });
  return cheerio.load(response.data);
}

function extractFields($) {
  if ($('title').text().includes('Robot Check') || $('title').text().includes('CAPTCHA')) {
    throw new Error('Amazon blocked the request (CAPTCHA).');
  }
  const title =
    $('#productTitle').text().trim() ||
    $('h1.a-size-large').first().text().trim() ||
    'Unknown';
  const rating =
    $('#acrPopover').attr('title') ||
    $('[data-hook="rating-out-of-text"]').text().trim() ||
    $('span.a-icon-alt').first().text().trim() || '';
  const reviewCount =
    $('#acrCustomerReviewText').first().text().trim() ||
    $('[data-hook="total-review-count"]').first().text().trim() || '0';

  const variantMatch = title.match(/\(([^)]+)\)/);
  const variant = variantMatch ? variantMatch[1] : title.split('-')[0].trim();

  return { title, variant, rating, reviewCount };
}

async function getProductInfo(url) {
  console.log(`  Fetching: ${url}`);
  const $ = await scrapeWithScraperAPI(url);
  const info = extractFields($);
  const ratingNum = parseFloat(info.rating.replace(',', '.'));
  const countNum  = parseInt(info.reviewCount.replace(/[^0-9]/g, ''), 10);

  // Use ASIN map to get the correct variant name
  const asin    = (url.match(/\/dp\/([A-Z0-9]{10})/i) || [])[1] || '';
  const variant = ASIN_VARIANT[asin] || info.variant;

  console.log(`    ${variant}  —  ${ratingNum} ★  (${countNum.toLocaleString()} ratings)`);
  return { variant, url, rating: ratingNum, count: countNum };
}

// ─── Grouping & remapping ─────────────────────────────────────────────────────

function groupByVariant(products) {
  const groups = {};
  for (const p of products) {
    const key = p.variant.toLowerCase().trim();
    if (!groups[key]) groups[key] = { variant: p.variant, urls: [], totalCount: 0, weightedSum: 0 };
    groups[key].urls.push(p.url);
    groups[key].totalCount += p.count;
    groups[key].weightedSum += p.rating * p.count;
  }
  return Object.values(groups).map(g => ({
    variant:      g.variant,
    urls:         g.urls,
    count:        g.totalCount,
    rating:       g.totalCount > 0 ? g.weightedSum / g.totalCount : 0,
    variantCount: 1,
  }));
}

function remapVariants(variants, rules) {
  const result = [];
  const used   = new Set();
  for (const rule of rules) {
    const matched = variants.filter(v =>
      rule.match.some(m => v.variant.toLowerCase().includes(m.toLowerCase()))
    );
    if (matched.length === 0) continue;
    const totalCount  = matched.reduce((s, v) => s + v.count, 0);
    const weightedSum = matched.reduce((s, v) => s + v.rating * v.count, 0);
    result.push({
      variant:      rule.label,
      urls:         matched.flatMap(v => v.urls),
      count:        totalCount,
      rating:       totalCount > 0 ? weightedSum / totalCount : 0,
      variantCount: matched.length,
    });
    matched.forEach(v => used.add(v.variant.toLowerCase()));
  }
  for (const v of variants) {
    if (!used.has(v.variant.toLowerCase())) result.push(v);
  }
  return result;
}

async function scrapeGroup(urls, label) {
  console.log(`\nScraping ${label}...`);
  const products = [];
  for (const url of urls) {
    try {
      const p = await getProductInfo(url);
      if (!isNaN(p.rating) && !isNaN(p.count)) products.push(p);
    } catch (e) {
      console.error(`  Failed: ${url} — ${e.message}`);
    }
  }
  const variants      = groupByVariant(products);
  const totalReviews  = variants.reduce((s, v) => s + v.count, 0);
  const weightedSum   = variants.reduce((s, v) => s + v.rating * v.count, 0);
  const weightedAvg   = totalReviews > 0 ? weightedSum / totalReviews : 0;
  console.log(`  → ${label}: ${totalReviews.toLocaleString()} total ratings, ${weightedAvg.toFixed(2)} ★ avg`);
  return { label, variants, totalReviews, weightedAvg };
}

// ─── Baselines (for week-over-week delta) ────────────────────────────────────

function loadBaselines() {
  if (!fs.existsSync(BASELINES_PATH)) return {};
  return JSON.parse(fs.readFileSync(BASELINES_PATH, 'utf8'));
}

function saveBaselines(data) {
  fs.writeFileSync(BASELINES_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function loadLastWeek() {
  if (!fs.existsSync(LAST_WEEK_PATH)) return {};
  return JSON.parse(fs.readFileSync(LAST_WEEK_PATH, 'utf8'));
}

function saveLastWeek(data) {
  fs.writeFileSync(LAST_WEEK_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function isMonday() {
  return new Date().getDay() === 1;
}

// ─── HTML patching helpers ────────────────────────────────────────────────────

function patch(html, marker, content) {
  const start = `<!-- ${marker}_START -->`;
  const end   = `<!-- ${marker}_END -->`;
  if (!html.includes(start)) {
    console.warn(`  Warning: marker ${start} not found in index.html`);
    return html;
  }
  return html.replace(
    new RegExp(`<!-- ${marker}_START -->[\\s\\S]*?<!-- ${marker}_END -->`),
    `${start}\n${content}\n      ${end}`
  );
}

function buildCardsHtml(variants, cssClass, domain) {
  return variants.map(v => {
    const cls      = cssClass ? ` ${cssClass}` : '';
    const urlsHtml = v.urls.map(u => {
      const asin = u.split('/dp/')[1] || u;
      return `        <a class="url-link" href="${u}" target="_blank">${domain}/dp/${asin}</a>`;
    }).join('\n');
    return `      <div class="card${cls}">
        <div class="variant">${v.variant}</div>
        <div class="stars">
          <span class="star-icons">&#9733;&#9733;&#9733;&#9733;&#9733;</span>
          <span class="rating-num">${v.rating.toFixed(1)}</span>
          <span class="rating-max">/ 5</span>
        </div>
        <div class="review-count"><span>${v.count.toLocaleString('en-US')}</span> ratings</div>
${urlsHtml}
      </div>`;
  }).join('\n\n');
}

function buildUSSummaryHtml(usData, lastWeekUS) {
  const lw       = lastWeekUS || { count: usData.totalReviews, rating: usData.weightedAvg };
  const delta    = usData.totalReviews - lw.count;
  const deltaStr = delta >= 0 ? `+${delta.toLocaleString('en-US')}` : delta.toLocaleString('en-US');
  const vWord    = usData.variants.length === 1 ? 'variant' : 'variants';
  return `        <div class="stat-block">
          <div class="label">Weighted Average Rating</div>
          <div class="value">${usData.weightedAvg.toFixed(1)} &#9733;</div>
          <div class="sub">out of 5 stars</div>
          <div class="stat-last-week">Last week &nbsp;${lw.rating.toFixed(1)} &#9733;</div>
        </div>
        <div class="stat-block">
          <div class="label">Total Customer Reviews</div>
          <div class="value-row">
            <span class="value">${usData.totalReviews.toLocaleString('en-US')}</span>
            <span class="stat-delta">${deltaStr}</span>
          </div>
          <div class="sub">across ${usData.variants.length} ${vWord}</div>
          <div class="stat-last-week">Last week &nbsp;${lw.count.toLocaleString('en-US')} reviews</div>
        </div>`;
}

function buildBrandSummaryHtml(brands, lastWeekBrands) {
  const parts = [];
  brands.forEach((b, i) => {
    const lw       = (lastWeekBrands && lastWeekBrands[b.variant]) || { count: b.count, rating: b.rating };
    const delta    = b.count - lw.count;
    const deltaStr = delta >= 0 ? `+${delta.toLocaleString('en-US')}` : delta.toLocaleString('en-US');
    const vWord    = b.variantCount === 1 ? 'variant' : 'variants';
    parts.push(`        <div class="brand-group">
          <div class="brand-label">${b.variant}</div>
          <div class="brand-stats">
            <div class="stat-block">
              <div class="label">Weighted Avg Rating</div>
              <div class="value">${b.rating.toFixed(1)} &#9733;</div>
              <div class="sub">out of 5 stars</div>
              <div class="stat-last-week">Last week &nbsp;${lw.rating.toFixed(1)} &#9733;</div>
            </div>
            <div class="stat-block">
              <div class="label">Total Reviews</div>
              <div class="value-row">
                <span class="value">${b.count.toLocaleString('en-US')}</span>
                <span class="stat-delta">${deltaStr}</span>
              </div>
              <div class="sub">across ${b.variantCount} ${vWord}</div>
              <div class="stat-last-week">Last week &nbsp;${lw.count.toLocaleString('en-US')} reviews</div>
            </div>
          </div>
        </div>`);
    if (i < brands.length - 1) parts.push('        <div class="brand-divider"></div>');
  });
  return parts.join('\n\n');
}

// ─── Patch dashboard ─────────────────────────────────────────────────────────

function patchDashboard(usData, ukRawVariants, ukBrands, deRawVariants, deBrands) {
  if (!fs.existsSync(DASHBOARD_PATH)) {
    console.error('index.html not found at', DASHBOARD_PATH);
    return;
  }

  const lastWeekData = loadLastWeek();
  const lastWeekUS   = lastWeekData.us || null;
  const lastWeekUK   = lastWeekData.uk || {};
  const lastWeekDE   = lastWeekData.de || {};

  let html = fs.readFileSync(DASHBOARD_PATH, 'utf8').replace(/\r\n/g, '\n');

  // Only patch a section if we actually got data — never wipe with empty results
  if (usData.variants.length > 0) {
    html = patch(html, 'US_CARDS',    buildCardsHtml(usData.variants, '', 'amazon.com'));
    html = patch(html, 'US_SUMMARY',  buildUSSummaryHtml(usData, lastWeekUS));
  } else {
    console.warn('  US scrape returned no data — skipping US update.');
  }

  if (ukRawVariants.length > 0) {
    html = patch(html, 'UK_CARDS', buildCardsHtml(ukRawVariants, 'uk', 'amazon.co.uk'));
    html = patch(html, 'UK_SUMMARY', buildBrandSummaryHtml(ukBrands, lastWeekUK));
  } else {
    console.warn('  UK scrape returned no data — skipping UK update.');
  }

  if (deRawVariants.length > 0) {
    html = patch(html, 'DE_CARDS', buildCardsHtml(deRawVariants, 'de', 'amazon.de'));
    html = patch(html, 'DE_SUMMARY', buildBrandSummaryHtml(deBrands, lastWeekDE));
  } else {
    console.warn('  DE scrape returned no data — skipping DE update.');
  }

  // Update last-updated timestamp in header
  const now = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'long', timeStyle: 'short' });
  html = html.replace(
    /<p>Amazon Ratings[^<]*<\/p>/,
    `<p>Amazon Ratings &amp; Reviews &mdash; Last updated: ${now} (PHT)</p>`
  );

  fs.writeFileSync(DASHBOARD_PATH, html, 'utf8');
  console.log('\nDashboard patched successfully.');

  // On Monday: rotate current baseline → last week, save new current
  if (isMonday()) {
    const newSnapshot = { weekStart: new Date().toISOString().split('T')[0], us: null, uk: {}, de: {} };
    if (usData.variants.length > 0)
      newSnapshot.us = { count: usData.totalReviews, rating: usData.weightedAvg };
    ukBrands.forEach(b => { newSnapshot.uk[b.variant] = { count: b.count, rating: b.rating }; });
    deBrands.forEach(b => { newSnapshot.de[b.variant] = { count: b.count, rating: b.rating }; });
    // Move old current → last week before overwriting
    const oldBaselines = loadBaselines();
    if (oldBaselines.uk || oldBaselines.de) saveLastWeek(oldBaselines);
    saveBaselines(newSnapshot);
    console.log('Baselines rotated — last week saved, new baseline set.');
  }
}

// ─── Product URLs ─────────────────────────────────────────────────────────────

const US_URLS = [
  'https://www.amazon.com/dp/B09S294TGM',
  'https://www.amazon.com/dp/B09S2LSQ4D',
  'https://www.amazon.com/dp/B09S2G3ZPP',
  'https://www.amazon.com/dp/B09S27FV5F',
];

const UK_URLS = [
  'https://www.amazon.co.uk/dp/B081VRSGWF',
  'https://www.amazon.co.uk/dp/B07YV7Z931',
  'https://www.amazon.co.uk/dp/B09S8VY9HY',
  'https://www.amazon.co.uk/dp/B09S8LT67H',
  'https://www.amazon.co.uk/dp/B083XZXVX7',
  'https://www.amazon.co.uk/dp/B07MQBK4W9',
];

const DE_URLS = [
  'https://www.amazon.de/dp/B079TP1P3V',   // EarthChamp
  'https://www.amazon.de/dp/B081VRSGWF',   // EarthChamp Chocolate
  'https://www.amazon.de/dp/B07GR9YY6X',   // EarthChamp Vanilla 1kg
  'https://www.amazon.de/dp/B083XNPSH1',   // EarthChamp Vanilla 1kg No Scoop
  'https://www.amazon.de/dp/B09S8RQ73K',   // EarthChamp Chocolate 2kg No Scoop
  'https://www.amazon.de/dp/B07MQBK4W9',   // Boho
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const singleUrl = process.argv[2];

  if (singleUrl) {
    // Single-URL debug mode
    const p = await getProductInfo(singleUrl);
    console.log(p);
    return;
  }

  console.log('Starting full scrape...');

  const usData = await scrapeGroup(US_URLS, 'US EarthChimp');
  const ukData = await scrapeGroup(UK_URLS, 'UK EarthChimp');
  const deData = await scrapeGroup(DE_URLS, 'DE EarthChimp');

  // Save pre-remap variants for card display
  const ukRawVariants = [...ukData.variants];
  const deRawVariants = [...deData.variants];

  // Remap for brand-level summary
  const ukBrands = remapVariants(ukData.variants, [
    { match: ['chocolate', 'vanilla'], label: 'EarthChamp' },
  ]);
  const deBrands = remapVariants(deData.variants, [
    { match: ['power blend', 'earthchamp', 'vegan protein', 'vanilla', 'chocolate'], label: 'EarthChamp' },
  ]);

  patchDashboard(usData, ukRawVariants, ukBrands, deRawVariants, deBrands);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
