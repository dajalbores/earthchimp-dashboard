// Amazon Product Rating Scraper
// Scrapes US/UK/DE Amazon listings and auto-generates dashboard.html

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// Load .env for local use; in GitHub Actions the secret is injected directly
require('dotenv').config();
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || 'c595fd63c5eae8f8edd9d570631860e1';
const DASHBOARD_PATH = path.join(__dirname, 'index.html');

// --- Axios scraper for Amazon US ---
async function scrapeWithAxios(url) {
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

  const title =
    $('#productTitle').text().trim() ||
    $('h1.a-size-large').first().text().trim() ||
    'Could not find title';

  const rating =
    $('#acrPopover').attr('title') ||
    $('[data-hook="rating-out-of-text"]').text().trim() ||
    $('span.a-icon-alt').first().text().trim() ||
    'Could not find rating';

  const reviewCount =
    $('#acrCustomerReviewText').first().text().trim() ||
    $('[data-hook="total-review-count"]').first().text().trim() ||
    'Could not find review count';

  return { title, rating, reviewCount };
}

// --- ScraperAPI scraper for Amazon UK/DE ---
async function scrapeWithScraperAPI(url) {
  const countryCode = url.includes('amazon.de') ? 'de' : 'gb';
  const scraperUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&country_code=${countryCode}&render=true`;
  const response = await axios.get(scraperUrl, { timeout: 60000 });
  const $ = cheerio.load(response.data);

  const title =
    $('#productTitle').text().trim() ||
    $('h1.a-size-large').first().text().trim() ||
    'Could not find title';

  const rating =
    $('#acrPopover').attr('title') ||
    $('[data-hook="rating-out-of-text"]').text().trim() ||
    $('span.a-icon-alt').first().text().trim() ||
    'Could not find rating';

  const reviewCount =
    $('#acrCustomerReviewText').first().text().trim() ||
    $('[data-hook="total-review-count"]').first().text().trim() ||
    'Could not find review count';

  return { title, rating, reviewCount };
}

// --- Unified scraper ---
async function getAmazonProductInfo(url) {
  console.log(`\nFetching: ${url}`);

  const isNonUS = url.includes('amazon.co.uk') || url.includes('amazon.de');
  const raw = isNonUS
    ? await scrapeWithScraperAPI(url)
    : await scrapeWithAxios(url);

  const variantMatch = raw.title.match(/\(([^)]+)\)/);
  const variant = variantMatch ? variantMatch[1] : raw.title.split('-')[0].trim();

  return { ...raw, variant, url };
}

// --- Group products by variant name, combining ratings/counts ---
function groupByVariant(products) {
  const groups = {};
  for (const p of products) {
    const key = p.variant.toLowerCase().trim();
    if (!groups[key]) {
      groups[key] = { variant: p.variant, urls: [], totalCount: 0, weightedSum: 0 };
    }
    groups[key].urls.push(p.url);
    groups[key].totalCount += p.count;
    groups[key].weightedSum += p.rating * p.count;
  }
  return Object.values(groups).map(g => ({
    variant: g.variant,
    urls: g.urls,
    count: g.totalCount,
    rating: g.totalCount > 0 ? g.weightedSum / g.totalCount : 0,
  }));
}

// --- Scrape a group of URLs, return structured data ---
async function scrapeGroup(urls, label) {
  const products = [];

  for (const url of urls) {
    try {
      const info = await getAmazonProductInfo(url);
      console.log('=== Amazon Product Info ===');
      console.log(`URL:          ${info.url}`);
      console.log(`Title:        ${info.title}`);
      console.log(`Variant:      ${info.variant}`);
      console.log(`Star Rating:  ${info.rating}`);
      console.log(`Review Count: ${info.reviewCount}`);
      console.log('');

      const ratingNum = parseFloat(info.rating.replace(',', '.'));
      const countNum = parseInt(info.reviewCount.replace(/[^0-9]/g, ''), 10);
      if (!isNaN(ratingNum) && !isNaN(countNum)) {
        products.push({ variant: info.variant, url, rating: ratingNum, count: countNum });
      }
    } catch (err) {
      console.error(`Failed for ${url}: ${err.message}\n`);
    }
  }

  const variants = groupByVariant(products);
  const totalReviews = variants.reduce((sum, v) => sum + v.count, 0);
  const weightedSum = variants.reduce((sum, v) => sum + v.rating * v.count, 0);
  const weightedAvg = totalReviews > 0 ? weightedSum / totalReviews : 0;

  console.log(`=== Summary: ${label} ===`);
  console.log(`${label} Total Reviews:           ${totalReviews.toLocaleString()}`);
  console.log(`${label} Weighted Average Rating: ${weightedAvg.toFixed(2)} out of 5 stars\n`);

  return { label, variants, totalReviews, weightedAvg };
}

// --- Generate HTML dashboard from scraped data ---
function generateDashboard(marketplaces) {
  const now = new Date().toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'long',
    timeStyle: 'short',
  });

  function renderMarketplace(mp) {
    const cls = mp.cssClass ? ` ${mp.cssClass}` : '';

    const cardsHtml = mp.data.variants.map(v => {
      const ratingDisplay = v.rating.toFixed(1);
      const countDisplay = v.count.toLocaleString('en-US');
      const urlsHtml = v.urls.map(u => {
        const asin = u.split('/dp/')[1] || u;
        const domain = u.includes('amazon.co.uk') ? 'amazon.co.uk'
          : u.includes('amazon.de') ? 'amazon.de'
          : 'amazon.com';
        return `        <a class="url-link" href="${u}" target="_blank">${domain}/dp/${asin}</a>`;
      }).join('\n');

      return `
      <div class="card${cls}">
        <div class="variant">${v.variant}</div>
        <div class="stars">
          <span class="star-icons">&#9733;&#9733;&#9733;&#9733;&#9733;</span>
          <span class="rating-num">${ratingDisplay}</span>
          <span class="rating-max">/ 5</span>
        </div>
        <div class="review-count"><span>${countDisplay}</span> ratings</div>
${urlsHtml}
      </div>`;
    }).join('\n');

    const totalDisplay = mp.data.totalReviews.toLocaleString('en-US');
    const avgDisplay = mp.data.weightedAvg.toFixed(1);
    const variantWord = mp.data.variants.length === 1 ? 'variant' : 'variants';

    return `
  <!-- ===== ${mp.title.toUpperCase()} ===== -->
  <div class="marketplace">
    <div class="marketplace-header">
      <h2>${mp.title}</h2>
      <span class="badge${cls}">${mp.badge}</span>
    </div>
    <div class="cards-grid">
${cardsHtml}
    </div>
    <div class="summary${cls}">
      <h3>${mp.summaryLabel} &mdash; Overall Summary</h3>
      <div class="summary-stats">
        <div class="stat-block">
          <div class="label">Weighted Average Rating</div>
          <div class="value">${avgDisplay} &#9733;</div>
          <div class="sub">out of 5 stars</div>
        </div>
        <div class="stat-block">
          <div class="label">Total Customer Reviews</div>
          <div class="value">${totalDisplay}</div>
          <div class="sub">across ${mp.data.variants.length} ${variantWord}</div>
        </div>
      </div>
    </div>
  </div>`;
  }

  const sectionsHtml = marketplaces.map(renderMarketplace).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>EarthChimp Marketplace Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      background: #f0f4f8;
      color: #2d3748;
      min-height: 100vh;
      padding: 32px 20px;
    }

    header {
      text-align: center;
      margin-bottom: 48px;
    }

    header h1 {
      font-size: 2rem;
      font-weight: 700;
      color: #1a202c;
    }

    header p {
      margin-top: 6px;
      font-size: 0.95rem;
      color: #718096;
    }

    /* Marketplace Section */
    .marketplace {
      max-width: 1100px;
      margin: 0 auto 56px;
    }

    .marketplace-header {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 24px;
    }

    .marketplace-header h2 {
      font-size: 1.3rem;
      font-weight: 700;
      color: #1a202c;
    }

    .badge {
      display: inline-block;
      background: #48bb78;
      color: white;
      font-size: 0.72rem;
      font-weight: 700;
      padding: 4px 12px;
      border-radius: 999px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .badge.uk { background: #4299e1; }
    .badge.de { background: #e53e3e; }

    /* Cards */
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 18px;
      margin-bottom: 24px;
    }

    .card {
      background: white;
      border-radius: 12px;
      padding: 22px 18px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.07);
      border-top: 4px solid #68d391;
      transition: transform 0.2s, box-shadow 0.2s;
    }

    .card.uk { border-top-color: #63b3ed; }
    .card.de { border-top-color: #fc8181; }

    .card:hover {
      transform: translateY(-4px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.11);
    }

    .card .variant {
      font-size: 1.05rem;
      font-weight: 700;
      color: #276749;
      margin-bottom: 14px;
    }

    .card.uk .variant { color: #2b6cb0; }
    .card.de .variant { color: #c53030; }

    .card .stars {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }

    .star-icons { color: #f6ad55; font-size: 1.1rem; letter-spacing: 1px; }

    .rating-num { font-size: 1.4rem; font-weight: 700; color: #2d3748; }

    .rating-max { font-size: 0.85rem; color: #a0aec0; }

    .review-count { font-size: 0.9rem; color: #4a5568; margin-top: 4px; }

    .review-count span { font-weight: 700; color: #2b6cb0; }

    .card .url-link {
      display: block;
      margin-top: 10px;
      font-size: 0.76rem;
      color: #63b3ed;
      text-decoration: none;
      word-break: break-all;
    }

    .card .url-link:hover { text-decoration: underline; }

    /* Summary Bar */
    .summary {
      border-radius: 14px;
      padding: 28px 36px;
      color: white;
      box-shadow: 0 4px 20px rgba(39, 103, 73, 0.25);
      background: linear-gradient(135deg, #276749, #48bb78);
    }

    .summary.uk {
      background: linear-gradient(135deg, #2b4c7e, #4299e1);
      box-shadow: 0 4px 20px rgba(43, 76, 126, 0.25);
    }

    .summary.de {
      background: linear-gradient(135deg, #9b2c2c, #e53e3e);
      box-shadow: 0 4px 20px rgba(155, 44, 44, 0.25);
    }

    .summary h3 {
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-bottom: 20px;
      opacity: 0.85;
    }

    .summary-stats { display: flex; gap: 48px; flex-wrap: wrap; }

    .stat-block .label {
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      opacity: 0.8;
      margin-bottom: 6px;
    }

    .stat-block .value {
      font-size: 2.2rem;
      font-weight: 800;
      line-height: 1;
    }

    .stat-block .sub {
      font-size: 0.82rem;
      opacity: 0.72;
      margin-top: 4px;
    }

    footer {
      text-align: center;
      margin-top: 16px;
      font-size: 0.8rem;
      color: #a0aec0;
    }
  </style>
</head>
<body>

  <header>
    <h1>EarthChimp Product Dashboard</h1>
    <p>Amazon Ratings &amp; Reviews &mdash; Last updated: ${now} (PHT)</p>
  </header>
${sectionsHtml}

  <footer>
    Data sourced from Amazon.com, Amazon.co.uk &amp; Amazon.de &nbsp;&middot;&nbsp; EarthChimp Marketplace Dashboard
  </footer>

</body>
</html>`;
}

// Hardcoded URLs to scrape
const US_URLS = [
  'https://www.amazon.com/dp/B09S294TGM',
  'https://www.amazon.com/dp/B09S2LSQ4D',
  'https://www.amazon.com/dp/B09S27FV5F',
  'https://www.amazon.com/dp/B09S2G3ZPP',
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
  'https://www.amazon.de/dp/B079TP1P3V',
  'https://www.amazon.de/dp/B07MQBK4W9',
];

async function main() {
  const singleUrl = process.argv[2];

  if (singleUrl) {
    // Single-URL mode: just print product info, no dashboard update
    const info = await getAmazonProductInfo(singleUrl);
    console.log('=== Amazon Product Info ===');
    console.log(`URL:          ${info.url}`);
    console.log(`Title:        ${info.title}`);
    console.log(`Variant:      ${info.variant}`);
    console.log(`Star Rating:  ${info.rating}`);
    console.log(`Review Count: ${info.reviewCount}`);
  } else {
    // Full scrape mode: scrape all marketplaces and regenerate dashboard
    console.log('Starting full scrape...\n');

    const usData  = await scrapeGroup(US_URLS, 'US EarthChimp');
    const ukData  = await scrapeGroup(UK_URLS, 'UK EarthChimp');
    const deData  = await scrapeGroup(DE_URLS, 'DE EarthChimp');

    const marketplaces = [
      { title: 'US Marketplace', badge: 'amazon.com',    cssClass: '',   summaryLabel: 'US EarthChimp', data: usData },
      { title: 'UK Marketplace', badge: 'amazon.co.uk',  cssClass: 'uk', summaryLabel: 'UK EarthChamp', data: ukData },
      { title: 'DE Marketplace', badge: 'amazon.de',     cssClass: 'de', summaryLabel: 'DE EarthChamp', data: deData },
    ];

    const html = generateDashboard(marketplaces);
    fs.writeFileSync(DASHBOARD_PATH, html, 'utf8');
    console.log(`\nDashboard updated: ${DASHBOARD_PATH}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
