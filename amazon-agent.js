// Amazon Product Rating Agent
// Uses Claude with tool use to fetch and parse Amazon product star ratings and review counts

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const client = new Anthropic();

// Tool: Fetch and extract relevant HTML from an Amazon product page
async function fetchAmazonPage(url) {
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

  // Remove scripts, styles, and nav to reduce noise
  $('script, style, nav, header, footer, #navFooter, #nav-main').remove();

  // Extract the product title
  const title = $('#productTitle').text().trim() ||
                $('h1.a-size-large').first().text().trim() ||
                'Unknown Product';

  // Try to directly extract the rating and review count
  const ratingText = $('#acrPopover').attr('title') ||
                     $('[data-hook="rating-out-of-text"]').text().trim() ||
                     $('.a-icon-star .a-icon-alt').first().text().trim() ||
                     '';

  const reviewCountText = $('#acrCustomerReviewText').text().trim() ||
                          $('[data-hook="total-review-count"]').text().trim() ||
                          '';

  // Also grab the rating summary section as fallback context
  const ratingSectionHtml = $('#averageCustomerReviews').html() ||
                            $('[data-hook="rating-out-of-text"]').parent().parent().html() ||
                            '';

  const ratingSectionText = cheerio.load(ratingSectionHtml || '').text().trim().slice(0, 1000);

  return {
    title,
    ratingText,
    reviewCountText,
    ratingSectionContext: ratingSectionText,
    url,
  };
}

// Tool definitions for Claude
const tools = [
  {
    name: 'fetch_amazon_product',
    description: 'Fetches an Amazon product page and extracts rating and review information. Returns the product title, any directly-found rating text, review count text, and surrounding context from the rating section.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full Amazon product URL (e.g. https://www.amazon.com/dp/B08...)',
        },
      },
      required: ['url'],
    },
  },
];

// Execute tool calls made by Claude
async function executeTool(toolName, toolInput) {
  if (toolName === 'fetch_amazon_product') {
    try {
      const data = await fetchAmazonPage(toolInput.url);
      return JSON.stringify(data, null, 2);
    } catch (err) {
      if (err.response && err.response.status === 503) {
        return JSON.stringify({ error: 'Amazon returned a 503 — the request was blocked. Try a different product URL or wait a moment.' });
      }
      return JSON.stringify({ error: `Failed to fetch page: ${err.message}` });
    }
  }
  return JSON.stringify({ error: `Unknown tool: ${toolName}` });
}

// Main agent function
async function analyzeAmazonProduct(productUrl) {
  console.log(`\nAnalyzing Amazon product: ${productUrl}\n`);

  const messages = [
    {
      role: 'user',
      content: `Please fetch the Amazon product page at this URL and tell me:
1. The product title
2. The star rating (out of 5)
3. The total number of customer ratings/reviews

URL: ${productUrl}`,
    },
  ];

  // Agentic loop
  while (true) {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      tools,
      messages,
    });

    // Append Claude's response to message history
    messages.push({ role: 'assistant', content: response.content });

    // If Claude is done, print the final answer
    if (response.stop_reason === 'end_turn') {
      const finalText = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      console.log('=== Result ===');
      console.log(finalText);
      return finalText;
    }

    // Handle tool calls
    if (response.stop_reason === 'tool_use') {
      const toolResults = [];

      for (const block of response.content) {
        if (block.type === 'tool_use') {
          console.log(`Calling tool: ${block.name}...`);
          const result = await executeTool(block.name, block.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      // Feed tool results back to Claude
      messages.push({ role: 'user', content: toolResults });
    }
  }
}

// Run the agent — pass an Amazon product URL as a command-line argument
// Usage: node amazon-agent.js "https://www.amazon.com/dp/XXXXXXXXXX"
const url = process.argv[2];

if (!url) {
  console.log('Usage: node amazon-agent.js "<amazon-product-url>"');
  console.log('Example: node amazon-agent.js "https://www.amazon.com/dp/B08N5WRWNW"');
  process.exit(1);
}

analyzeAmazonProduct(url).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
