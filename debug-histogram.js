const axios = require('axios');
const cheerio = require('cheerio');

(async () => {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.5',
    'Cache-Control': 'max-age=0',
  };
  const r = await axios.get('https://www.amazon.com/dp/B09S294TGM', { headers, timeout: 15000 });
  const $ = cheerio.load(r.data);

  console.log('--- aria-label values in histogramTable ---');
  $('#histogramTable a[aria-label]').each((i, el) => {
    console.log($(el).attr('aria-label'));
  });
})().catch(e => console.error(e.message));
