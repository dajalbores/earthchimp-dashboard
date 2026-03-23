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
  // "DD Month YYYY" → UK/DE format
  let m = s.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (m) return m[3] + '-' + (MONTHS[m[2].toLowerCase()]||'01') + '-' + m[1].padStart(2,'0');
  // "Month DD, YYYY" or "Month DD YYYY" → US format
  m = s.match(/(\w+)\s+(\d{1,2}),?\s*(\d{4})/);
  if (m) return m[3] + '-' + (MONTHS[m[1].toLowerCase()]||'01') + '-' + m[2].padStart(2,'0');
  return '';
}

function parseStars(str) {
  if (!str) return 5;
  const stars = ((str).match(/★/g)||[]).length;
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

// ─── Format detection ─────────────────────────────────────────────────────────
// Three formats exist:
//   us-star : ★★★★★ | Reviewer on Date / Title / Body / ASIN|Brand|Flavor|Size
//   us-kv   : REVIEW N / Reviewer: / Date: / Rating: / Title: / Product: / Action: / "body"
//   standard: Reviewer : / Date : / Rating : / Title : / Body or Comment : / Status :

function detectFormat(content) {
  if (/★/.test(content.slice(0, 500))) return 'us-star';
  if (/^Action\s*:/im.test(content))   return 'us-kv';
  return 'standard';
}

// ─── US Star format ───────────────────────────────────────────────────────────

function parseUSStarBlocks(content, marketplace) {
  const reviews = [];
  const blocks  = content.split(/^-{3,}\s*$/m);

  for (const block of blocks) {
    const lines = block.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 3) continue;

    // Header: ★★★★★ | Reviewer on Month DD, YYYY
    const hm = lines[0].match(/^(★+[☆★]*)\s*\|\s*(.+?)\s+on\s+(.+)$/);
    if (!hm) continue;

    const stars    = (hm[1].match(/★/g)||[]).length;
    const reviewer = hm[2].trim();
    const date     = parseDate(hm[3].trim());
    if (!date) continue;

    // Meta line (last): ASIN | Brand | Flavor | Size | scoop
    const metaParts = lines[lines.length - 1].split('|').map(p => p.trim());
    const childAsin = metaParts[0] || '';
    const flavor    = metaParts[2] || '';
    const sizeRaw   = metaParts[3] || '';
    const noScoop   = /no.?scoop/i.test(lines[lines.length - 1]);

    let size = '';
    const lbM = sizeRaw.match(/(\d+)\s*lb/i);
    const ozM = sizeRaw.match(/(\d+)\s*oz/i);
    if (lbM)      size = (parseInt(lbM[1]) * 16) + ' Oz';
    else if (ozM) size = ozM[1] + ' Oz';

    const product = [flavor, size, noScoop ? 'No Scoop' : ''].filter(Boolean).join(' ');
    const title   = lines[1];
    const body    = lines.slice(2, lines.length - 1).join(' ');

    reviews.push({ marketplace, reviewer, date, stars, title, body, product, childAsin,
      actionStatus: statusFromStars(stars) });
  }
  return reviews;
}

// ─── US Key-Value format ──────────────────────────────────────────────────────

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

    const productRaw = get('Product');
    const childAsin  = extractAsin(productRaw) || extractAsin(get('Child ASIN'));
    const productClean = productRaw.replace(/\s*\([A-Z0-9]{10}\)/g, '').trim();

    // Body is text wrapped in quotes
    const bodyMatch = block.match(/"([\s\S]+?)"/);
    const body = bodyMatch ? bodyMatch[1].replace(/\s+/g, ' ').trim() : '';

    reviews.push({
      marketplace,
      reviewer,
      date:         parseDate(get('Date')),
      stars:        parseStars(get('Rating')),
      title:        get('Title'),
      body,
      product:      normalizeProduct(productClean, ''),
      childAsin,
      actionStatus: parseStatus(get('Action'))
    });
  }
  return reviews;
}

// ─── Standard (UK / DE) format ────────────────────────────────────────────────

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
      if (/^\s{2,}/.test(line) && !/^\s*[\w][\w\s.]*\s*:/.test(line)) {
        val += ' ' + line.trim();
      } else break;
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
    const r = {
      marketplace,
      reviewer,
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

// ─── Main file parser (auto-detects format) ───────────────────────────────────

function parseTxtFile(filePath, marketplace) {
  const content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  const fmt     = detectFormat(content);
  console.log('  Format detected: ' + fmt);
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

function esc(s) {
  return (s||'').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

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
  let html = fs.readFileSync(INDEX_PATH, 'utf8').replace(/\r\n/g, '\n');
  const existing = getExistingKeys(html);
  const toAdd    = newReviews.filter(r => !existing.has(r.reviewer+'|'+r.date+'|'+r.title));

  if (toAdd.length === 0) {
    console.log('  No new reviews to add (all already exist in dashboard).');
    return 0;
  }

  let nextId = getNextId(html);
  const lines = toAdd.map(r => reviewToJs(r, nextId++));

  // Insert before the closing ]; of the reviews array
  const marker  = '}\n    ];';
  const lastIdx = html.lastIndexOf(marker);
  if (lastIdx === -1) throw new Error('Could not find reviews array closing marker in index.html');

  html = html.slice(0, lastIdx+1)
       + ',\n' + lines.join(',\n')
       + '\n    ];'
       + html.slice(lastIdx + marker.length);

  fs.writeFileSync(INDEX_PATH, html, 'utf8');
  console.log('  Added ' + toAdd.length + ' review(s) to index.html');
  return toAdd.length;
}

// ─── Git commit & push ────────────────────────────────────────────────────────

function gitPush(message) {
  try {
    execSync('git add index.html', { cwd: __dirname, stdio: 'pipe' });
    execSync('git commit -m "' + message + '"', { cwd: __dirname, stdio: 'pipe' });
    execSync('git push', { cwd: __dirname, stdio: 'pipe' });
    console.log('  Pushed to GitHub — dashboard will update shortly.');
  } catch (e) {
    console.error('  Git push failed:', e.message);
  }
}

// ─── File watcher ─────────────────────────────────────────────────────────────

function folderToPrefix(folderName) {
  return folderName.toLowerCase().replace(/\s+/g, '-');
}

function folderToMarketplace(folderName) {
  const m = folderName.match(/^(\w+)\s+Reviews?/i);
  return m ? m[1].toUpperCase() : folderName.toUpperCase();
}

function getNextNumber(dir, prefix) {
  const re = new RegExp('^' + prefix + '-page-(\\d+)\\.txt$', 'i');
  return fs.readdirSync(dir).reduce(function(max, f) {
    const m = f.match(re);
    return m ? Math.max(max, parseInt(m[1], 10)) : max;
  }, 0) + 1;
}

const pending   = {};
const processed = new Set();

function handleFile(dir, prefix, marketplace, filename) {
  if (!filename.toLowerCase().endsWith('.txt')) return;

  const src          = path.join(dir, filename);
  const alreadyNamed = new RegExp('^' + prefix + '-page-\\d+\\.txt$', 'i');

  setTimeout(function () {
    if (!fs.existsSync(src)) return;
    if (processed.has(src)) return;  // already handled this file

    let finalPath = src;

    // Step 1: rename if needed
    if (!alreadyNamed.test(filename)) {
      const n       = getNextNumber(dir, prefix);
      const newName = prefix + '-page-' + n + '.txt';
      const dest    = path.join(dir, newName);
      try {
        fs.renameSync(src, dest);
        console.log('\n[' + new Date().toLocaleTimeString() + '] Renamed: ' + filename + ' → ' + newName);
        finalPath = dest;
        processed.add(dest);  // prevent re-processing when watch fires for new name
      } catch (e) {
        console.error('Rename failed:', e.message);
        return;
      }
    } else {
      processed.add(src);
      console.log('\n[' + new Date().toLocaleTimeString() + '] New file detected: ' + filename);
    }

    // Step 2: parse reviews from the (now correctly named) file
    let reviews;
    try {
      reviews = parseTxtFile(finalPath, marketplace);
      console.log('  Parsed ' + reviews.length + ' review(s) from ' + path.basename(finalPath));
    } catch (e) {
      console.error('  Parse error:', e.message);
      return;
    }

    // Step 3: inject into index.html
    let added;
    try {
      added = injectReviews(reviews);
    } catch (e) {
      console.error('  Inject error:', e.message);
      return;
    }

    // Step 4: commit and push if anything was added
    if (added > 0) {
      gitPush('Auto-add ' + added + ' ' + marketplace + ' review(s) from ' + path.basename(finalPath));
    }

    // Clean up after 10s so the same file can be re-processed if re-added later
    setTimeout(function () { processed.delete(finalPath); processed.delete(src); }, 10000);
  }, 500);
}

function watchFolder(dir) {
  if (!fs.existsSync(dir)) return;
  const folderName  = path.basename(dir);
  const prefix      = folderToPrefix(folderName);
  const marketplace = folderToMarketplace(folderName);

  fs.watch(dir, function (eventType, filename) {
    if (!filename) return;
    const key = dir + '|' + filename;
    if (pending[key]) return;
    pending[key] = true;
    setTimeout(function () { delete pending[key]; }, 1000);

    if (eventType === 'rename' && fs.existsSync(path.join(dir, filename))) {
      handleFile(dir, prefix, marketplace, filename);
    }
  });

  console.log('Watching: ' + dir + '  [marketplace: ' + marketplace + ', prefix: ' + prefix + ']');
}

const watched = {};

function scanAndWatch() {
  fs.readdirSync(REVIEWS_ROOT).forEach(function (name) {
    const fullPath = path.join(REVIEWS_ROOT, name);
    if (fs.statSync(fullPath).isDirectory() && !watched[fullPath]) {
      watched[fullPath] = true;
      watchFolder(fullPath);
    }
  });
}

// Also watch the Reviews/ root so newly created country folders are auto-detected
fs.watch(REVIEWS_ROOT, function (eventType, name) {
  if (!name) return;
  const fullPath = path.join(REVIEWS_ROOT, name);
  if (
    eventType === 'rename' &&
    fs.existsSync(fullPath) &&
    fs.statSync(fullPath).isDirectory() &&
    !watched[fullPath]
  ) {
    watched[fullPath] = true;
    watchFolder(fullPath);
    console.log('New folder detected — now watching: ' + fullPath);
  }
});

if (!fs.existsSync(REVIEWS_ROOT)) {
  console.error('Reviews folder not found: ' + REVIEWS_ROOT);
  process.exit(1);
}

scanAndWatch();
console.log('\nWatcher running. Drop any .txt file into a Reviews subfolder to auto-add reviews to the dashboard.\nPress Ctrl+C to stop.\n');
