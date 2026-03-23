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
  const m = (str||'').trim().match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (!m) return '';
  return m[3] + '-' + (MONTHS[m[2].toLowerCase()]||'01') + '-' + m[1].padStart(2,'0');
}

function parseStars(str) {
  const m = (str||'').match(/(\d)/);
  return m ? parseInt(m[1], 10) : 5;
}

function parseStatus(str) {
  const s = (str||'').toLowerCase();
  if (/\*+\s*contact\s*customer\s*\*+/.test(s)) return 'contact';
  if (s.includes('contacted'))  return 'contacted';
  if (s.includes('contact'))    return 'contact';
  if (s.includes('refund'))     return 'refund';
  return 'positive';
}

function normalizeProduct(name, brand) {
  if (!name) return '';
  const b = (brand||'').toLowerCase();
  const n = name.toLowerCase();

  // Third-party brands (BOHO, Farmer Pete's, etc.)
  if (b === 'boho' || n.includes('boho')) {
    const sz = name.match(/(\d+)\s*kg/i);
    return 'BOHO Protein ' + (sz ? sz[1]+'kg' : '1kg');
  }
  if (n.includes("farmer pete")) {
    const sz = name.match(/(\d+)\s*kg/i);
    return "Farmer Pete's " + (sz ? sz[1]+'kg' : '1kg');
  }

  // EarthChimp / EarthChamp products — extract flavor, size, scoop
  let flavor = 'Plain';
  if (/vanilla/i.test(name))    flavor = 'Vanilla';
  else if (/chocolate/i.test(name)) flavor = 'Chocolate';

  let size = '';
  const sz = name.match(/(\d+)\s*(kg|oz)/i);
  if (sz) size = sz[1] + sz[2].toLowerCase();

  const noScoop = /no scoop|without.*dosing|no.*scoop/i.test(name);
  return [flavor, size, noScoop ? 'No Scoop' : ''].filter(Boolean).join(' ');
}

// Extract a named field from a text block, handling indented continuation lines
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

function parseBlock(block, marketplace) {
  const reviewer = getField(block, ['Reviewer']);
  if (!reviewer) return null;
  return {
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
}

function parseTxtFile(filePath, marketplace) {
  const content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  const blocks  = content.split(/^[-=]{3,}\s*$/m);
  const reviews = [];
  for (const block of blocks) {
    const r = parseBlock(block, marketplace);
    if (r && r.reviewer && r.date && r.title) reviews.push(r);
  }
  return reviews;
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
