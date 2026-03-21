// Auto-rename watcher for SS Customer Reviews folder
// Watches for new images and renames them sequentially: 1-image, 2-image, 3-image...

const fs = require('fs');
const path = require('path');

const FOLDER = __dirname;
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];

function isImage(filename) {
  return IMAGE_EXTS.includes(path.extname(filename).toLowerCase());
}

function getNextNumber() {
  const files = fs.readdirSync(FOLDER);
  let max = 0;
  for (const f of files) {
    const match = f.match(/^(\d+)-image\./);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

console.log(`Watching: ${FOLDER}`);
console.log('Drop images into the folder — they will be renamed automatically.\n');

fs.watch(FOLDER, (eventType, filename) => {
  if (!filename || eventType !== 'rename') return;
  if (!isImage(filename)) return;

  // Skip already-renamed files (e.g. 1-image.png)
  if (/^\d+-image\./.test(filename)) return;

  const srcPath = path.join(FOLDER, filename);

  // Wait briefly to ensure the file is fully written
  setTimeout(() => {
    if (!fs.existsSync(srcPath)) return;

    const ext = path.extname(filename).toLowerCase();
    const num = getNextNumber();
    const newName = `${num}-image${ext}`;
    const destPath = path.join(FOLDER, newName);

    fs.renameSync(srcPath, destPath);
    console.log(`Renamed: ${filename}  →  ${newName}`);
  }, 500);
});
