import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

/** Content-addressed bytes never go stale; the bounds only limit retained thumbnails. */
const MAX_CACHED_TASK_IMAGES = 48;
/** Base64 characters retained across settled entries (about 48 MB of image bytes). */
export const MAX_CACHED_TASK_IMAGE_CHARS = 64 * 1024 * 1024;
/** One delayed retry covers a transient transport failure such as a runtime restart. */
export const TASK_IMAGE_RETRY_DELAY_MS = 500;

interface CachedTaskImage {
	request: Promise<string | null>;
	/** Base64 length once resolved; zero while in flight. */
	chars: number;
}

const cachedImageData = new Map<string, CachedTaskImage>();
/** Keys whose request has not yet settled. The LRU eviction below must never
 * drop one of these: its caller is still awaiting the exact promise instance
 * held in `cachedImageData`, and dropping the map entry while unresolved
 * would just cause a future caller to issue a duplicate, wasted fetch for
 * data that's already on the way — defeating "in-flight reads are shared"
 * for no reason, since the dropped entry's own caller is unaffected either way. */
const pendingKeys = new Set<string>();
let cachedChars = 0;

function toCacheKey(projectId: string, sha256: string): string {
	return `${projectId}\u0000${sha256}`;
}

function removeEntry(key: string): void {
	const entry = cachedImageData.get(key);
	if (!entry) return;
	cachedChars -= entry.chars;
	cachedImageData.delete(key);
}

/**
 * Evicts the oldest *settled* entries until both bounds hold. An unresolved
 * in-flight request is skipped — its caller still needs the exact promise
 * instance in the map — so the entry bound can temporarily grow past
 * MAX_CACHED_TASK_IMAGES while many reads are concurrently in flight; it
 * shrinks back down as each one settles.
 */
function evictSettledEntries(): void {
	for (const key of cachedImageData.keys()) {
		if (cachedImageData.size <= MAX_CACHED_TASK_IMAGES && cachedChars <= MAX_CACHED_TASK_IMAGE_CHARS) return;
		if (!pendingKeys.has(key)) removeEntry(key);
	}
}

async function readTaskImageData(projectId: string, sha256: string): Promise<string | null> {
	const query = async () => await getRuntimeTrpcClient(projectId).taskImages.get.query({ sha256 });
	let response: Awaited<ReturnType<typeof query>>;
	try {
		response = await query();
	} catch {
		await new Promise((resolve) => setTimeout(resolve, TASK_IMAGE_RETRY_DELAY_MS));
		response = await query();
	}
	return response?.data ?? null;
}

/**
 * Lazily reads one stored attachment for the project that owns the card.
 * Resolves base64 data, or null when the runtime no longer has the blob.
 * In-flight reads are shared; a transient failure is retried once; failed or
 * missing reads are not retained, so a later mount reads again.
 */
export function fetchTaskImageData(projectId: string, sha256: string): Promise<string | null> {
	const key = toCacheKey(projectId, sha256);
	const cached = cachedImageData.get(key);
	if (cached) {
		cachedImageData.delete(key);
		cachedImageData.set(key, cached);
		return cached.request;
	}
	pendingKeys.add(key);
	const entry: CachedTaskImage = { request: readTaskImageData(projectId, sha256), chars: 0 };
	cachedImageData.set(key, entry);
	const forget = () => {
		if (cachedImageData.get(key) === entry) removeEntry(key);
	};
	void entry.request.then(
		(data) => {
			pendingKeys.delete(key);
			if (data === null) {
				forget();
				return;
			}
			if (cachedImageData.get(key) !== entry) return;
			entry.chars = data.length;
			cachedChars += data.length;
			evictSettledEntries();
		},
		() => {
			pendingKeys.delete(key);
			forget();
		},
	);
	evictSettledEntries();
	return entry.request;
}

export function resetTaskImageDataCacheForTests(): void {
	cachedImageData.clear();
	pendingKeys.clear();
	cachedChars = 0;
}
