// Module-level TTL cache for kubectl/docker CLI results.
// Keyed by cache key string, stores {data, expiresAt}.
// TTL driven by BACKTRACK_SCRAPE_INTERVAL env var (default 10s).

type CacheEntry<T> = {
	data: T;
	expiresAt: number;
};

type CacheStore = Map<string, CacheEntry<unknown>>;

declare global {
	// eslint-disable-next-line no-var
	var __overviewCache: CacheStore | undefined;
}

function getStore(): CacheStore {
	if (!global.__overviewCache) {
		global.__overviewCache = new Map();
	}
	return global.__overviewCache;
}

export async function getCached<T>(
	key: string,
	ttlMs: number,
	fetcher: () => Promise<T>,
): Promise<T> {
	const store = getStore();
	const now = Date.now();
	const entry = store.get(key) as CacheEntry<T> | undefined;

	if (entry && now < entry.expiresAt) {
		return entry.data;
	}

	const data = await fetcher();
	store.set(key, { data, expiresAt: now + ttlMs });
	return data;
}
