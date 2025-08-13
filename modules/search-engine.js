import fetch from 'node-fetch';

const SEARCH_API_KEY = process.env.SEARCH_API_KEY; // Your API key
const SEARCH_BASE_URL = 'https://api.bing.microsoft.com/v7.0/search';

/**
 * Performs a safe web search and returns structured results.
 * @param {string} query - Search query
 * @returns {Promise<Array>} Array of search results
 */
export async function performWebSearch(query) {
  const endpoint = `${SEARCH_BASE_URL}?q=${encodeURIComponent(query)}&count=5`;

  try {
    // Live API fetch
    const response = await fetch(endpoint, {
      headers: {
        'Ocp-Apim-Subscription-Key': SEARCH_API_KEY
      }
    });

    if (!response.ok) {
      throw new Error(`Search API error: ${response.status}`);
    }

    const data = await response.json();

    // Filter and format results
    const results = (data.webPages?.value || []).map(item => ({
      title: item.name,
      url: item.url,
      snippet: item.snippet,
      timestamp: new Date().toISOString()
    }));

    // Content filter (basic example)
    const safeResults = results.filter(r =>
      !/explicit|nsfw|unsafe/i.test(r.snippet)
    );

    // Audit log
    console.log({
      timestamp: new Date().toISOString(),
      module: 'search-engine',
      query,
      resultCount: safeResults.length,
      results: safeResults
    });

    return safeResults;
  } catch (err) {
    console.error({
      timestamp: new Date().toISOString(),
      module: 'search-engine',
      status: 'error',
      error: err.message
    });
    throw err;
  }
}
