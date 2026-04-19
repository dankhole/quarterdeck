import { useCallback, useEffect, useRef, useState } from "react";

const LOCK_KEY = "quarterdeck-active-tab";
const CHANNEL_NAME = "quarterdeck-single-tab";
const HEARTBEAT_MS = 2_000;
const STALE_MS = 5_000;

interface LockEntry {
	id: string;
	ts: number;
}

function getOrCreateTabId(): string {
	const existing = sessionStorage.getItem("quarterdeck-tab-id");
	if (existing) return existing;
	const id = crypto.randomUUID();
	sessionStorage.setItem("quarterdeck-tab-id", id);
	return id;
}

function readLock(): LockEntry | null {
	try {
		const raw = localStorage.getItem(LOCK_KEY);
		return raw ? (JSON.parse(raw) as LockEntry) : null;
	} catch {
		return null;
	}
}

function writeLock(id: string): void {
	localStorage.setItem(LOCK_KEY, JSON.stringify({ id, ts: Date.now() }));
}

function clearLockIfOwned(id: string): void {
	const lock = readLock();
	if (lock?.id === id) localStorage.removeItem(LOCK_KEY);
}

function isLockHeldByOther(id: string): boolean {
	const lock = readLock();
	return lock !== null && lock.id !== id && Date.now() - lock.ts < STALE_MS;
}

export function useSingleTabGuard(): { isBlocked: boolean; forceOpen: () => void } {
	const [isBlocked, setIsBlocked] = useState(false);
	const tabIdRef = useRef(getOrCreateTabId());
	const channelRef = useRef<BroadcastChannel | null>(null);
	const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const stopHeartbeat = useCallback(() => {
		if (heartbeatRef.current) {
			clearInterval(heartbeatRef.current);
			heartbeatRef.current = null;
		}
	}, []);

	const startHeartbeat = useCallback(() => {
		stopHeartbeat();
		const id = tabIdRef.current;
		writeLock(id);
		heartbeatRef.current = setInterval(() => writeLock(id), HEARTBEAT_MS);
	}, [stopHeartbeat]);

	const forceOpen = useCallback(() => {
		channelRef.current?.postMessage({ type: "yield" });
		startHeartbeat();
		setIsBlocked(false);
	}, [startHeartbeat]);

	useEffect(() => {
		const id = tabIdRef.current;
		const channel = new BroadcastChannel(CHANNEL_NAME);
		channelRef.current = channel;

		if (isLockHeldByOther(id)) {
			setIsBlocked(true);
		} else {
			startHeartbeat();
		}

		channel.onmessage = (event: MessageEvent) => {
			if (event.data?.type === "yield") {
				stopHeartbeat();
				clearLockIfOwned(id);
				setIsBlocked(true);
			}
		};

		const onUnload = () => clearLockIfOwned(id);
		window.addEventListener("beforeunload", onUnload);

		return () => {
			stopHeartbeat();
			clearLockIfOwned(id);
			channel.close();
			channelRef.current = null;
			window.removeEventListener("beforeunload", onUnload);
		};
	}, [startHeartbeat, stopHeartbeat]);

	// When blocked, watch for the other tab to close or crash
	useEffect(() => {
		if (!isBlocked) return;

		const id = tabIdRef.current;

		const tryUnblock = () => {
			if (!isLockHeldByOther(id)) {
				startHeartbeat();
				setIsBlocked(false);
			}
		};

		const onStorage = (e: StorageEvent) => {
			if (e.key === LOCK_KEY || e.key === null) tryUnblock();
		};
		window.addEventListener("storage", onStorage);
		const poll = setInterval(tryUnblock, HEARTBEAT_MS);

		return () => {
			window.removeEventListener("storage", onStorage);
			clearInterval(poll);
		};
	}, [isBlocked, startHeartbeat]);

	return { isBlocked, forceOpen };
}
