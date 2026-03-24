// process-reviews.js
// Scans all Reviews subfolders, parses every .txt file found,
// injects new reviews into index.html, and pushes to GitHub.
// Run manually:  node process-reviews.js
// Or via Claude Code slash command:  /update-reviews

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REVIEWS_ROOT = path.join(__dirname, 'Reviews');
const INDEX_PATH   = path.join(__dirname, 'index.html');

// ─── Parsing helpers ──────────────────────────────────────────────────────────

const MONTHS = {
  january:'01', february:'02', march:'03',    april:'04',
  may:'05',     june:'06',     july:'07',     august:'08',
  september:'09', october:'10', november:'11', december:'12'
};

function parseDate(str) {
  if (!str) return '';
  const s = str.trim();
  let m = s.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (m) return m[3] + '-' + (MONTHS[m[2].toLowerCase()]||'01') + '-' + m[1].padStart(2,'0');
  m = s.match(/(\w+)\s+(\d{1,2}),?\s*(\d{4})/);
  if (m) return m[3] + '-' + (MONTHS[m[1].toLowerCase()]||'01') + '-' + m[2].padStart(2,'0');
  return '';
}

function parseStars(str) {
  if (!str) return 5;
  const stars = (str.match(/★/g)||[]).length;
  if (stars > 0) return stars;
  const m = str.match(/(\d)/);
  return m ? parseInt(m[1], 10) : 5;
}

function parseStatus(str) {
  const s = (str||'').toLowerCase();
  if (/\*+\s*(offer\s*)?courtesy\s*refund\s*\*+/.test(s)) return 'refund';
  if (/\*+\s*contact\s*customer\s*\*+/.test(s))            return 'contact';
  if (s.includes('contacted'))  return 'contacted';
  if (s.includes('contact'))    return 'contact';
  if (s.includes('refund'))     return 'refund';
  return 'positive';
}

function statusFromStars(stars) {
  if (stars >= 4) return 'positive';
  if (stars <= 2) return 'refund';
  return 'contact';
}

function normalizeProduct(name, brand) {
  if (!name) return '';
  const b = (brand||'').toLowerCase();
  const n = name.toLowerCase();
  if (b === 'boho' || n.includes('boho')) {
    const sz = name.match(/(\d+)\s*kg/i);
    return 'BOHO Protein ' + (sz ? sz[1]+'kg' : '1kg');
  }
  if (n.includes('farmer pete')) {
    const sz = name.match(/(\d+)\s*kg/i);
    return "Farmer Pete's " + (sz ? sz[1]+'kg' : '1kg');
  }
  if (n.includes('power blend')) {
    const sz = name.match(/(\d+)\s*kg/i);
    return 'Power Blend ' + (sz ? sz[1]+'kg' : '1kg');
  }
  let flavor = 'Plain';
  if (/vanilla/i.test(name))        flavor = 'Vanilla';
  else if (/chocolate/i.test(name)) flavor = 'Chocolate';
  let size = '';
  const kgOz = name.match(/(\d+)\s*(kg|oz)/i);
  const lb   = name.match(/(\d+)\s*lb/i);
  if (kgOz) size = kgOz[1] + kgOz[2].toLowerCase();
  else if (lb) size = (parseInt(lb[1]) * 16) + ' Oz';
  const noScoop = /no scoop|without.*dosing|no.*scoop/i.test(name);
  return [flavor, size, noScoop ? 'No Scoop' : ''].filter(Boolean).join(' ');
}

function extractAsin(str) {
  const m = (str||'').match(/\b([A-Z0-9]{10})\b/);
  return m ? m[1] : '';
}

// ─── Format detection & parsers ───────────────────────────────────────────────

function detectFormat(content) {
  if (/★/.test(content.slice(0, 500))) return 'us-star';
  if (/^Action\s*:/im.test(content))   return 'us-kv';
  return 'standard';
}

function parseUSStarBlocks(content, marketplace) {
  const reviews = [];
  const blocks  = content.split(/^-{3,}\s*$/m);
  for (const block of blocks) {
    const lines = block.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 3) continue;
    const hm = lines[0].match(/^(★+[☆★]*)\s*\|\s*(.+?)\s+on\s+(.+)$/);
    if (!hm) continue;
    const stars    = (hm[1].match(/★/g)||[]).length;
    const reviewer = hm[2].trim();
    const date     = parseDate(hm[3].trim());
    if (!date) continue;
    const metaParts = lines[lines.length - 1].split('|').map(p => p.trim());
    const childAsin = metaParts[0] || '';
    const flavor    = metaParts[2] || '';
    const sizeRaw   = metaParts[3] || '';
    const noScoop   = /no.?scoop/i.test(lines[lines.length - 1]);
    let size = '';
    const lbM = sizeRaw.match(/(\d+)\s*lb/i);
    const ozM = sizeRaw.match(/(\d+)\s*oz/i);
    if (lbM) size = (parseInt(lbM[1]) * 16) + ' Oz';
    else if (ozM) size = ozM[1] + ' Oz';
    const product = [flavor, size, noScoop ? 'No Scoop' : ''].filter(Boolean).join(' ');
    reviews.push({ marketplace, reviewer, date, stars, title: lines[1],
      body: lines.slice(2, lines.length - 1).join(' '),
      product, childAsin, actionStatus: statusFromStars(stars) });
  }
  return reviews;
}

function parseUSKVBlocks(content, marketplace) {
  const reviews = [];
  const blocks  = content.split(/^[-=]{3,}\s*$/m);
  for (const block of blocks) {
    if (!/^Reviewer\s*:/im.test(block)) continue;
    const get = (key) => {
      const re = new RegExp('^' + key + '\\s*:\\s*(.+)', 'im');
      const m  = block.match(re);
      return m ? m[1].trim() : '';
    };
    const reviewer   = get('Reviewer');
    if (!reviewer) continue;
    const productRaw   = get('Product');
    const childAsin    = extractAsin(productRaw) || extractAsin(get('Child ASIN'));
    const productClean = productRaw.replace(/\s*\([A-Z0-9]{10}\)/g, '').trim();
    const bodyMatch    = block.match(/"([\s\S]+?)"/);
    reviews.push({ marketplace, reviewer,
      date:         parseDate(get('Date')),
      stars:        parseStars(get('Rating')),
      title:        get('Title'),
      body:         bodyMatch ? bodyMatch[1].replace(/\s+/g, ' ').trim() : '',
      product:      normalizeProduct(productClean, ''),
      childAsin,
      actionStatus: parseStatus(get('Action'))
    });
  }
  return reviews;
}

function getField(block, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(?:^|\\n)' + escaped + '\\s*:\\s*([^\\n]+)', 'i');
    const m  = block.match(re);
    if (!m || !m[1].trim()) continue;
    let val = m[1].trim();
    const afterPos = block.indexOf(m[0]) + m[0].length;
    for (const line of block.slice(afterPos).split('\n')) {
      if (!line.trim()) break;
      if (/^\s{2,}/.test(line) && !/^\s*[\w][\w\s.]*\s*:/.test(line)) val += ' ' + line.trim();
      else break;
    }
    return val.replace(/\s+/g, ' ').trim();
  }
  return '';
}

function parseStandardBlocks(content, marketplace) {
  const reviews = [];
  const blocks  = content.split(/^[-=]{3,}\s*$/m);
  for (const block of blocks) {
    const reviewer = getField(block, ['Reviewer']);
    if (!reviewer) continue;
    const r = { marketplace, reviewer,
      date:         parseDate(getField(block,  ['Date'])),
      stars:        parseStars(getField(block, ['Rating'])),
      title:        getField(block, ['Title']),
      body:         getField(block, ['Body', 'Comment']),
      product:      normalizeProduct(getField(block, ['Product']), getField(block, ['Brand'])),
      childAsin:    getField(block, ['Child ASIN']),
      actionStatus: parseStatus(getField(block, ['Status']))
    };
    if (r.reviewer && r.date && r.title) reviews.push(r);
  }
  return reviews;
}

function parseTxtFile(filePath, marketplace) {
  const content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  const fmt     = detectFormat(content);
  if (fmt === 'us-star') return parseUSStarBlocks(content, marketplace);
  if (fmt === 'us-kv')   return parseUSKVBlocks(content, marketplace);
  return parseStandardBlocks(content, marketplace);
}

// ─── HTML injection ───────────────────────────────────────────────────────────

function getNextId(html) {
  let max = 0, m;
  const re = /\{id:(\d+),/g;
  while ((m = re.exec(html)) !== null) max = Math.max(max, parseInt(m[1], 10));
  return max + 1;
}

function getExistingKeys(html) {
  const keys = new Set();
  const re   = /reviewer:"([^"]+)",date:"([^"]+)"[^}]*?title:"([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) keys.add(m[1]+'|'+m[2]+'|'+m[3]);
  return keys;
}

function esc(s) { return (s||'').replace(/\\/g,'\\\\').replace(/"/g,'\\"'); }

function reviewToJs(r, id) {
  return '      {id:'+id
    +',marketplace:"'+r.marketplace+'"'
    +',reviewer:"'+esc(r.reviewer)+'"'
    +',date:"'+r.date+'"'
    +',stars:'+r.stars
    +',title:"'+esc(r.title)+'"'
    +',body:"'+esc(r.body)+'"'
    +',product:"'+esc(r.product)+'"'
    +',childAsin:"'+r.childAsin+'"'
    +',actionStatus:"'+r.actionStatus+'"}';
}

function injectReviews(newReviews) {
  let html     = fs.readFileSync(INDEX_PATH, 'utf8').replace(/\r\n/g, '\n');
  const existing = getExistingKeys(html);
  const toAdd    = newReviews.filter(r => !existing.has(r.reviewer+'|'+r.date+'|'+r.title));
  if (toAdd.length === 0) return 0;
  let nextId   = getNextId(html);
  const lines  = toAdd.map(r => reviewToJs(r, nextId++));
  const marker = '}\n    ];';
  const idx    = html.lastIndexOf(marker);
  if (idx === -1) throw new Error('Could not find reviews array closing marker in index.html');
  html = html.slice(0, idx+1) + ',\n' + lines.join(',\n') + '\n    ];' + html.slice(idx + marker.length);
  fs.writeFileSync(INDEX_PATH, html, 'utf8');
  return toAdd.length;
}

// ─── Git push ─────────────────────────────────────────────────────────────────

function gitPush(message) {
  execSync('git add index.html', { cwd: __dirname, stdio: 'pipe' });
  execSync('git commit -m "' + message + '"', { cwd: __dirname, stdio: 'pipe' });
  execSync('git push', { cwd: __dirname, stdio: 'pipe' });
}

// ─── Folder → marketplace name ────────────────────────────────────────────────

function folderToMarketplace(folderName) {
  const m = folderName.match(/^(\w+)\s+Reviews?/i);
  return m ? m[1].toUpperCase() : folderName.toUpperCase();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  if (!fs.existsSync(REVIEWS_ROOT)) {
    console.error('Reviews folder not found: ' + REVIEWS_ROOT);
    process.exit(1);
  }

  const subfolders = fs.readdirSync(REVIEWS_ROOT).filter(name => {
    return fs.statSync(path.join(REVIEWS_ROOT, name)).isDirectory();
  });

  let totalAdded = 0;
  const summary  = [];

  for (const folder of subfolders) {
    const dir         = path.join(REVIEWS_ROOT, folder);
    const marketplace = folderToMarketplace(folder);
    const txts        = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.txt'));

    if (txts.length === 0) continue;

    let folderAdded = 0;
    for (const txt of txts) {
      const filePath = path.join(dir, txt);
      try {
        const reviews = parseTxtFile(filePath, marketplace);
        const added   = injectReviews(reviews);
        folderAdded  += added;
        if (added > 0)
          console.log('  [' + marketplace + '] ' + txt + ' → ' + added + ' new review(s) added');
        else
          console.log('  [' + marketplace + '] ' + txt + ' → no new reviews (already in dashboard)');
      } catch (e) {
        console.error('  [' + marketplace + '] Error processing ' + txt + ': ' + e.message);
      }
    }
    totalAdded += folderAdded;
    summary.push({ marketplace, added: folderAdded });
  }

  if (totalAdded > 0) {
    const msg = summary
      .filter(s => s.added > 0)
      .map(s => s.added + ' ' + s.marketplace)
      .join(', ') + ' review(s) added';
    try {
      gitPush('Auto-add ' + msg);
      console.log('\nPushed to GitHub — dashboard will update shortly.');
    } catch (e) {
      console.error('\nGit push failed: ' + e.message);
    }
  } else {
    console.log('\nNo new reviews found — dashboard is already up to date.');
  }

  console.log('\nDone. Total new reviews added: ' + totalAdded);
}

main();
