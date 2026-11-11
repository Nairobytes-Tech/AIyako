import { z } from 'zod';

export const webSearchSchema = z.object({
    query: z.string().min(1, 'Search query is required').max(500, 'Search query is too long'),
    num_results: z.number().int().min(1).max(20).optional().default(8),
});

const DEFAULT_SEARXNG_URL = 'http://localhost:8080';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const cache = new Map();

function getBaseUrl() {
    return (process.env.SEARXNG_URL || DEFAULT_SEARXNG_URL).replace(/\/+$/, '');
}

function cacheKey(baseUrl, query, numResults) {
    return `${baseUrl}|${query.trim().toLowerCase()}|${numResults}`;
}

function pruneCache() {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (entry.expires <= now) cache.delete(key);
    }
    while (cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
}

function normalizeResults(results, limit) {
    const seen = new Set();
    const normalized = [];

    for (const item of results) {
        const url = typeof item?.url === 'string' ? item.url.trim() : '';
        const title = typeof item?.title === 'string' ? item.title.trim() : '';
        if (!url || !title || seen.has(url)) continue;

        seen.add(url);
        normalized.push({
            title,
            url,
            snippet: typeof item.content === 'string'
                ? item.content.trim()
                : (typeof item.snippet === 'string' ? item.snippet.trim() : ''),
        });

        if (normalized.length >= limit) break;
    }

    return normalized;
}

export function clearWebSearchCache() {
    cache.clear();
}

export async function webSearch(input) {
    const parsed = webSearchSchema.safeParse(input);
    if (!parsed.success) {
        const errors = parsed.error.issues || parsed.error.errors || [];
        const msg = errors.length > 0 ? errors[0].message : 'Validation failed';
        return { success: false, error: msg };
    }

    const { query, num_results } = parsed.data;
    const baseUrl = getBaseUrl();

    let searchUrl;
    try {
        searchUrl = new URL(`${baseUrl}/search`);
    } catch {
        return { success: false, error: `Invalid SEARXNG_URL: ${baseUrl}` };
    }

    if (searchUrl.protocol !== 'http:' && searchUrl.protocol !== 'https:') {
        return { success: false, error: 'SEARXNG_URL must use http or https' };
    }

    const key = cacheKey(baseUrl, query, num_results);
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) {
        return {
            success: true,
            data: { query, results: cached.results, cached: true },
        };
    }

    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('format', 'json');
    searchUrl.searchParams.set('safesearch', '1');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await fetch(searchUrl, {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
            return { success: false, error: `Search backend returned HTTP ${response.status}` };
        }

        const data = await response.json();
        if (!data || !Array.isArray(data.results)) {
            return { success: false, error: 'Search backend returned an invalid response' };
        }

        const results = normalizeResults(data.results, num_results);
        pruneCache();
        cache.set(key, { expires: Date.now() + CACHE_TTL_MS, results });

        return {
            success: true,
            data: { query, results, cached: false },
        };
    } catch (err) {
        if (err.name === 'AbortError') {
            return { success: false, error: 'Search request timed out' };
        }
        return { success: false, error: `Search request failed: ${err.message}` };
    } finally {
        clearTimeout(timeout);
    }
}
