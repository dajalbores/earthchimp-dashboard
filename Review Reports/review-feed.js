// Review Feed — Seller Central Automation
// Logs into Amazon Seller Central and scrapes actual customer review text
// (title, body, rating, date) for all US products since last Monday.
//
// Setup: add to .env —
//   SELLER_CENTRAL_EMAIL=your@email.com
//   SELLER_CENTRAL_PASSWORD=yourpassword
//
// Run: node review-feed.js
// Note: Runs with a visible browser window so you can handle 2FA if prompted.

require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const REVIEW_FEED_PATH = path.join(__dirname, 'review-feed.json');
const COOKIES_PATH = path.join(__dirname, '.sc-cookies.json');
const SELLER_CENTRAL_URL = 'https://sellercentral.amazon.com';

// US products to track
const PRODUCTS = [
  { asin: 'B09S294TGM', variant: 'Chocolate' },
  { asin: 'B09S2LSQ4D', variant: 'Plain & Unsweetened' },
  { asin: 'B09S2G3ZPP', variant: 'Plain & Unsweetened (2)' },
  { asin: 'B09S27FV5F', variant: 'Vanilla' },
];

// --- Helpers ---

function getMondayDate(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function isOnSignIn(url) {
  return url.includes('signin') || url.includes('sign-in') || url.includes('ap/signin') || url.includes('midway-auth.amazon.com');
}

// --- Session management ---

async function loadCookies(page) {
  if (!fs.existsSync(COOKIES_PATH)) return false;
  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
    await page.setCookie(...cookies);
    return true;
  } catch { return false; }
}

async function saveCookies(page) {
  try {
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  } catch { /* ignore if browser already closed */ }
}

// --- Login ---

async function login(page) {
  const username = process.env.SELLER_CENTRAL_EMAIL;
  const password = process.env.SELLER_CENTRAL_PASSWORD;

  if (!username || !password) {
    throw new Error('Missing SELLER_CENTRAL_EMAIL or SELLER_CENTRAL_PASSWORD in .env');
  }

  console.log('  Navigating to sign-in...');
  await page.goto(`${SELLER_CENTRAL_URL}/sign-in`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);
  await page.screenshot({ path: path.join(__dirname, 'debug-login-1.png') });
  console.log('  Screenshot: debug-login-1.png');
  console.log('  URL:', page.url());

  // Step 1: Handle IdP selector page ("Choose Your Login")
  // Two providers: sc_na_amazon_v2 (standard Amazon) and prod.sellercentral.federate (Midway)
  const bodyText = await page.evaluate(() => document.body.innerText);
  if (bodyText.includes('Choose Your Login') || bodyText.includes('Identity Provider')) {
    console.log('  IdP selector detected — clicking Amazon/Seller Central login...');
    // Try sc_na_amazon_v2 first (standard seller account login)
    const scLink = await page.$('#sc_na_amazon_v2');
    if (scLink) {
      await scLink.click();
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await sleep(2000);
    } else {
      // Fall back to first link on the page
      const firstLink = await page.$('a[href*="mons_idp"]');
      if (firstLink) {
        await firstLink.click();
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await sleep(2000);
      }
    }
    await page.screenshot({ path: path.join(__dirname, 'debug-login-1b.png') });
    console.log('  Screenshot: debug-login-1b.png (after IdP selection)');
    console.log('  URL after IdP select:', page.url());
  }

  // Step 2: Wait for login form
  console.log('  Waiting for login form...');
  await page.waitForFunction(
    () => document.querySelector('#user_name') ||
          document.querySelector('#ap_email') ||
          document.querySelector('input[type="text"]') ||
          document.querySelector('input[type="email"]'),
    { timeout: 15000 }
  ).catch(() => console.log('  Warning: could not detect a login form after 15s'));
  await sleep(500);

  console.log('  URL:', page.url());

  // Midway Authentication Portal — selectors: #user_name, #password, #verify_btn
  const userField = await page.$('#user_name');
  console.log('  Midway user_name field found:', !!userField);

  if (userField) {
    // --- Midway login flow ---
    await userField.click({ clickCount: 3 });
    await userField.type(username, { delay: 60 });
    await sleep(500);

    const passField = await page.$('#password');
    console.log('  Midway password field found:', !!passField);
    if (passField) {
      await passField.click({ clickCount: 3 });
      await passField.type(password, { delay: 60 });
    }

    const verifyBtn = await page.$('#verify_btn');
    console.log('  Midway verify_btn found:', !!verifyBtn);
    if (verifyBtn) {
      await verifyBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await sleep(2000);
    }

    await page.screenshot({ path: path.join(__dirname, 'debug-login-2.png') });
    console.log('  Screenshot: debug-login-2.png (after Midway submit)');
    console.log('  URL:', page.url());

    // Handle Midway OTP if prompted
    const otpField = await page.$('#otp-field');
    if (otpField) {
      console.log('\n  *** OTP required — enter it in the browser window ***');
      console.log('  Waiting up to 90 seconds for OTP completion...');
      await page.waitForFunction(
        () => !document.querySelector('#otp-field'),
        { timeout: 90000 }
      );
      await sleep(2000);
      await page.screenshot({ path: path.join(__dirname, 'debug-login-3.png') });
      console.log('  Screenshot: debug-login-3.png (after OTP)');
    }

  } else {
    // --- Fallback: standard Amazon ap/signin flow ---
    console.log('  Midway not detected — trying standard ap/signin...');
    const emailField = await page.$('#ap_email');
    console.log('  ap_email field found:', !!emailField);
    if (emailField) {
      await emailField.click({ clickCount: 3 });
      await emailField.type(username, { delay: 60 });
      const continueBtn = await page.$('#continue');
      if (continueBtn) {
        await continueBtn.click();
        await sleep(2500);
      }
    }
    const passField = await page.$('#ap_password');
    if (passField) {
      await passField.click({ clickCount: 3 });
      await passField.type(password, { delay: 60 });
      const signInBtn = await page.$('#signInSubmit');
      if (signInBtn) {
        await signInBtn.click();
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
        await sleep(2000);
      }
    }

    await page.screenshot({ path: path.join(__dirname, 'debug-login-2.png') });
    console.log('  Screenshot: debug-login-2.png (after standard login)');
    console.log('  URL:', page.url());

    // Handle standard 2FA if prompted
    const urlAfterLogin = page.url();
    if (urlAfterLogin.includes('mfa') || urlAfterLogin.includes('challenge') || urlAfterLogin.includes('verification') || urlAfterLogin.includes('cvf')) {
      console.log('\n');
      console.log('  ==========================================================');
      console.log('  *** 2FA REQUIRED — CHECK YOUR BROWSER WINDOW NOW ***');
      console.log('  Enter the OTP/verification code in the browser.');
      console.log('  Waiting up to 3 minutes...');
      console.log('  ==========================================================\n');
      await page.waitForFunction(
        () => !window.location.href.includes('mfa') &&
              !window.location.href.includes('challenge') &&
              !window.location.href.includes('verification') &&
              !window.location.href.includes('cvf'),
        { timeout: 180000 }
      );
      await sleep(2000);
      await page.screenshot({ path: path.join(__dirname, 'debug-login-3.png') });
      console.log('  Screenshot: debug-login-3.png (after 2FA)');
    }
  }

  const finalUrl = page.url();
  console.log('  Final URL:', finalUrl);
  if (isOnSignIn(finalUrl)) {
    await page.screenshot({ path: path.join(__dirname, 'debug-login-fail.png') });
    throw new Error('Login failed — still on sign-in page. Check credentials in .env');
  }

  console.log('  Login successful.');
  await saveCookies(page);
}

// --- Account switcher ---

async function handleAccountSwitcher(page) {
  const body = await page.evaluate(() => document.body.innerText);
  if (!body.includes('Select an account') && !body.includes('Switch between')) return;

  console.log('\n  ==========================================================');
  console.log('  *** ACCOUNT SWITCHER — ACTION REQUIRED ***');
  console.log('  In the browser window:');
  console.log('    1. Click "United States"');
  console.log('    2. Click the "Select Account" button that appears');
  console.log('  Waiting up to 2 minutes...');
  console.log('  ==========================================================\n');

  await page.waitForFunction(
    () => !window.location.href.includes('account-switcher'),
    { timeout: 120000 }
  );
  await sleep(1500);
  console.log('  Account selected. URL:', page.url());
  await saveCookies(page);
}

// --- Ensure logged in ---

async function ensureLoggedIn(page) {
  console.log('  Checking session...');
  await page.goto(`${SELLER_CENTRAL_URL}/home`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1500);

  if (isOnSignIn(page.url())) {
    console.log('  Not logged in — signing in now...');
    await login(page);
  } else {
    await handleAccountSwitcher(page);
    console.log('  Session valid.');
  }
}

// --- Scrape reviews for one ASIN ---

async function extractReviewsFromPage(page) {
  return await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.reviewContainer')];
    const results = [];

    for (const card of cards) {
      // Rating
      const ratingEl = card.querySelector('kat-star-rating.reviewRating');
      const rating = ratingEl ? parseInt(ratingEl.getAttribute('value') || '0', 10) : 0;

      // Reviewer + date from header span
      const headerSpan = card.querySelector('span.css-g7g1lz');
      let reviewer = '', reviewDate = '';
      if (headerSpan) {
        const m = headerSpan.innerText.match(/^Review by (.+?) on (.+)$/);
        if (m) { reviewer = m[1].trim(); reviewDate = m[2].trim(); }
      }

      // Title: div whose id ends with "-title", get the bold text
      const titleDiv = card.querySelector('[id$="-title"]');
      const title = titleDiv ? (titleDiv.querySelector('b') || titleDiv).innerText.trim() : '';

      // Body: div whose id starts with "review-content-"
      const bodyDiv = card.querySelector('[id^="review-content-"]');
      const body = bodyDiv ? bodyDiv.innerText.trim().slice(0, 1500) : '';

      // Child ASIN from .asinDetail section
      let childAsin = '';
      const asinDetail = card.querySelector('.asinDetail');
      if (asinDetail) {
        const labelDivs = [...asinDetail.querySelectorAll('div')];
        for (let i = 0; i < labelDivs.length; i++) {
          if (labelDivs[i].innerText.trim() === 'Child ASIN' && labelDivs[i + 1]) {
            childAsin = labelDivs[i + 1].innerText.trim();
            break;
          }
        }
        // Fallback: extract ASIN from product link
        if (!childAsin) {
          const link = asinDetail.querySelector('a[href*="/dp/"]');
          if (link) {
            const m = link.href.match(/\/dp\/([A-Z0-9]{10})/);
            if (m) childAsin = m[1];
          }
        }
      }

      results.push({ rating, title, body, reviewer, reviewDate, childAsin });
    }
    return results;
  });
}


// Scrape all brand reviews since `since`, grouped by childAsin
async function scrapeAllBrandReviews(page, since) {
  const url = `${SELLER_CENTRAL_URL}/brand-customer-reviews/ref=xx_crvws_dnav_xx#sortBy=RECENT`;
  console.log('\n  Navigating to Brand Customer Reviews...');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  if (isOnSignIn(page.url())) {
    console.log('  Session expired — re-logging in...');
    await login(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
  }

  await handleAccountSwitcher(page);

  if (!page.url().includes('brand-customer-reviews')) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
  }

  await page.waitForFunction(
    () => document.querySelectorAll('.reviewContainer').length > 0,
    { timeout: 15000 }
  ).catch(() => {});

  const reviews = await extractReviewsFromPage(page);
  console.log(`  Found ${reviews.length} reviews on page 1`);

  // Group by childAsin, filtered to since date
  const byAsin = {};
  for (const r of reviews) {
    const d = r.reviewDate ? new Date(r.reviewDate) : null;
    if (d && !isNaN(d) && d < since) continue;

    const asinKey = r.childAsin || 'unknown';
    if (!byAsin[asinKey]) byAsin[asinKey] = { positive: [], negative: [] };
    if (r.rating >= 4) byAsin[asinKey].positive.push(r);
    else if (r.rating >= 1) byAsin[asinKey].negative.push(r);
  }

  return byAsin;
}

// --- Main ---

async function main() {
  const since = getMondayDate();
  const sinceStr = since.toISOString().split('T')[0];
  const today = new Date().toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'full',
  });

  console.log(`\nUS Marketplace — WTD Review Feed (Seller Central)`);
  console.log(`Date       : ${today}`);
  console.log(`Since      : Monday ${sinceStr}\n`);
  console.log('='.repeat(62));

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized', '--no-sandbox'],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );

  try {
    await loadCookies(page);
    await ensureLoggedIn(page);

    const byAsin = await scrapeAllBrandReviews(page, since);

    const allResults = PRODUCTS.map(p => ({
      asin: p.asin,
      variant: p.variant,
      positive: (byAsin[p.asin] || {}).positive || [],
      negative: (byAsin[p.asin] || {}).negative || [],
    }));

    // Save results
    const report = {
      scrapedAt: today,
      weekStart: sinceStr,
      products: allResults,
      brandReviewsByAsin: byAsin,
    };
    fs.writeFileSync(REVIEW_FEED_PATH, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\nSaved to review-feed.json`);

    // Print summary for tracked products
    console.log('\n' + '='.repeat(62));
    console.log('Tracked products (since Monday):');
    for (const r of allResults) {
      console.log(`  ${r.variant} (${r.asin}): +${r.positive.length} positive, -${r.negative.length} negative`);
      for (const rev of r.negative) {
        console.log(`\n    ⚠ NEGATIVE REVIEW — ${rev.rating}★ | ASIN: ${r.asin}`);
        console.log(`    Reviewer : ${rev.reviewer} (${rev.reviewDate})`);
        console.log(`    Title    : ${rev.title}`);
        console.log(`    Review   : ${rev.body}`);
      }
    }

    // Print brand-level reviews found (all ASINs)
    const brandAsins = Object.keys(byAsin);
    if (brandAsins.length) {
      console.log('\nBrand reviews found this week (all ASINs):');
      for (const [asin, { positive, negative }] of Object.entries(byAsin)) {
        console.log(`  ${asin}: +${positive.length} / -${negative.length}`);
        for (const r of [...positive, ...negative]) {
          console.log(`    ${r.rating}★ ${r.reviewer} (${r.reviewDate}): ${r.title}`);
        }
        for (const r of negative) {
          console.log(`\n    ⚠ NEGATIVE REVIEW — ${r.rating}★ | ASIN: ${asin}`);
          console.log(`    Reviewer : ${r.reviewer} (${r.reviewDate})`);
          console.log(`    Title    : ${r.title}`);
          console.log(`    Review   : ${r.body}`);
        }
      }
    } else {
      console.log('\nNo new brand reviews found since Monday.');
    }

    await saveCookies(page);

  } catch (err) {
    console.error('Error:', err.message);
    console.error(err.stack);
  } finally {
    console.log('\nClosing browser in 5 seconds...');
    await sleep(5000);
    await browser.close();
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
