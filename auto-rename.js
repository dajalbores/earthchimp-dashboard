const fs   = require('fs');
const path = require('path');

const REVIEWS_ROOT = path.join(__dirname, 'Reviews');

// Convert folder name to file prefix  e.g. "US Reviews" → "us-reviews"
function folderToPrefix(folderName) {
  return folderName.toLowerCase().replace(/\s+/g, '-');
}

// Returns the next page number by scanning existing files in the folder
function getNextNumber(dir, prefix) {
  const re  = new RegExp('^' + prefix + '-page-(\\d+)\\.txt$', 'i');
  const max = fs.readdirSync(dir).reduce(function(m, f) {
    const match = f.match(re);
    return match ? Math.max(m, parseInt(match[1], 10)) : m;
  }, 0);
  return max + 1;
}

// Debounce map — prevents double-firing from fs.watch
const pending = {};

function handleFile(dir, prefix, filename) {
  // Only handle .txt files
  if (!filename.toLowerCase().endsWith('.txt')) return;

  // Skip files already following the naming pattern
  const alreadyNamed = new RegExp('^' + prefix + '-page-\\d+\\.txt$', 'i');
  if (alreadyNamed.test(filename)) return;

  const src = path.join(dir, filename);

  // Wait 500ms to ensure the file is fully written before renaming
  setTimeout(function() {
    if (!fs.existsSync(src)) return; // already renamed or deleted

    const n       = getNextNumber(dir, prefix);
    const newName = prefix + '-page-' + n + '.txt';
    const dest    = path.join(dir, newName);

    try {
      fs.renameSync(src, dest);
      console.log('[' + new Date().toLocaleTimeString() + '] Renamed: ' + filename + ' → ' + newName);
    } catch (e) {
      console.error('Could not rename "' + filename + '": ' + e.message);
    }
  }, 500);
}

// Start watching a single subfolder
function watchFolder(dir) {
  if (!fs.existsSync(dir)) return;

  const folderName = path.basename(dir);
  const prefix     = folderToPrefix(folderName);

  fs.watch(dir, function(eventType, filename) {
    if (!filename) return;

    const key = dir + '|' + filename;
    if (pending[key]) return;
    pending[key] = true;
    setTimeout(function() { delete pending[key]; }, 1000);

    if (eventType === 'rename' && fs.existsSync(path.join(dir, filename))) {
      handleFile(dir, prefix, filename);
    }
  });

  console.log('Watching: ' + dir + '  (prefix: ' + prefix + ')');
}

// Scan Reviews/ for existing subfolders and watch each one
const watched = {};

function scanAndWatch() {
  fs.readdirSync(REVIEWS_ROOT).forEach(function(name) {
    const fullPath = path.join(REVIEWS_ROOT, name);
    if (fs.statSync(fullPath).isDirectory() && !watched[fullPath]) {
      watched[fullPath] = true;
      watchFolder(fullPath);
    }
  });
}

// Also watch Reviews/ itself so new subfolders are auto-detected
fs.watch(REVIEWS_ROOT, function(eventType, name) {
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
    console.log('New folder detected and now watching: ' + fullPath);
  }
});

// Kick off
if (!fs.existsSync(REVIEWS_ROOT)) {
  console.error('Reviews folder not found: ' + REVIEWS_ROOT);
  process.exit(1);
}

scanAndWatch();
console.log('\nAuto-rename watcher running. Press Ctrl+C to stop.\n');
