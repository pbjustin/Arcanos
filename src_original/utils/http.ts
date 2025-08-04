/**
 * HTTP utilities for ARCANOS
 * Safe HTML fetching functions with proper error handling
 */

import axios from "axios";

/**
 * Result interface for safeFetchHtml function
 */
export interface SafeFetchHtmlResult {
  error: string | null;
  raw: string | null;
}

/**
 * Safely fetch HTML content from a URL with proper content-type validation
 * 
 * @param url - The URL to fetch HTML content from
 * @returns Promise resolving to an object with either raw HTML data or error message
 */
export async function safeFetchHtml(url: string): Promise<SafeFetchHtmlResult> {
  try {
    const res = await axios.get(url, {
      headers: { "User-Agent": "ARCANOS/1.0" }
    });

    const contentType = res.headers["content-type"];
    if (!contentType || !contentType.includes("text/html")) {
      console.warn(`⚠️ Unsupported content-type for ${url}: ${contentType}`);
      return { error: `Unsupported content-type: ${contentType}`, raw: null };
    }

    return { raw: res.data, error: null };

  } catch (err: any) {
    console.error(`🛑 Fetch failed for ${url}:`, err.message);
    return { error: err.message, raw: null };
  }
}