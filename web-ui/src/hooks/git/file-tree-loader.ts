import type { RuntimeListFilesResponse } from "@/runtime/types";
import { type FileTreeDirectoryPages, mergeDirectoryPage } from "./file-tree-pages";

interface DirectoryRequest {
	directory: string;
	cursor?: string;
	allowCollapsed: boolean;
	resolve: (data: RuntimeListFilesResponse | null) => void;
}

/** Serializes each directory and caps active-scope listing fanout at two requests. */
export class FileTreeLoader {
	pages: FileTreeDirectoryPages = {};
	visible = new Set([""]);
	private queue: DirectoryRequest[] = [];
	private pending = new Map<string, Promise<RuntimeListFilesResponse | null>>();
	private inFlight = 0;
	private generation = 0;
	private active = false;
	private loadedPageCounts = new Map<string, number>();

	constructor(
		private readonly fetchPage: (directory: string, cursor?: string) => Promise<RuntimeListFilesResponse>,
		private readonly publish: () => void,
	) {}

	start(): void {
		this.active = true;
	}

	stop(): void {
		this.active = false;
		this.generation += 1;
		for (const request of this.queue) request.resolve(null);
		this.queue = [];
		this.pending.clear();
		this.pages = Object.fromEntries(
			Object.entries(this.pages).map(([directory, page]) => [directory, { ...page, loading: false }]),
		);
	}

	load(directory: string, append = false, allowCollapsed = false): Promise<RuntimeListFilesResponse | null> {
		if (!this.active) return Promise.resolve(null);
		const pending = this.pending.get(directory);
		if (pending) return pending;
		const cursor = append ? this.pages[directory]?.data?.nextCursor : undefined;
		if (append && !cursor) return Promise.resolve(null);
		const promise = new Promise<RuntimeListFilesResponse | null>((resolve) => {
			this.queue.push({ directory, allowCollapsed, ...(cursor ? { cursor } : {}), resolve });
		});
		this.pending.set(directory, promise);
		const previous = this.pages[directory] ?? { data: null, loading: false, error: null };
		this.pages = {
			...this.pages,
			[directory]: {
				...previous,
				loading: true,
				loadingVisible: append || !previous.data || Boolean(previous.error),
			},
		};
		this.publish();
		this.drain();
		return promise;
	}

	async refresh(directory: string): Promise<RuntimeListFilesResponse | null> {
		const pending = this.pending.get(directory);
		if (pending) await pending;
		return await this.load(directory, false, true);
	}

	private async fetchDirectory(
		request: DirectoryRequest,
		previous: RuntimeListFilesResponse | null,
		generation: number,
	): Promise<{ data: RuntimeListFilesResponse; count: number } | null> {
		const previousCount = this.loadedPageCounts.get(request.directory) ?? 1;
		const desiredCount = previousCount + (request.cursor ? 1 : 0);
		let page = await this.fetchPage(request.directory, request.cursor);
		if (!this.active || generation !== this.generation) return null;
		if (previous?.snapshotId === page.snapshotId) {
			return { data: mergeDirectoryPage(previous, page, Boolean(request.cursor)), count: desiredCount };
		}
		// Restore only the depth the user already requested. Keep the old projection
		// visible until this bounded replacement is complete, including empty pages.
		let data = page;
		let count = 1;
		for (let examined = 1; data.nextCursor && count < desiredCount; examined += 1) {
			if (examined >= desiredCount)
				throw new Error("Directory changed repeatedly while restoring loaded pages. Retry.");
			if (
				!this.active ||
				generation !== this.generation ||
				(!request.allowCollapsed && !this.visible.has(request.directory))
			)
				return null;
			page = await this.fetchPage(request.directory, data.nextCursor);
			if (!this.active || generation !== this.generation) return null;
			const sameSnapshot = data.snapshotId === page.snapshotId;
			data = mergeDirectoryPage(data, page, true);
			count = sameSnapshot ? count + 1 : 1;
		}
		return { data, count };
	}

	private drain(): void {
		while (this.active && this.inFlight < 2 && this.queue.length > 0) {
			const request = this.queue.shift()!;
			if (!request.allowCollapsed && !this.visible.has(request.directory)) {
				this.pending.delete(request.directory);
				this.pages = { ...this.pages, [request.directory]: { ...this.pages[request.directory]!, loading: false } };
				this.publish();
				request.resolve(null);
				continue;
			}
			this.inFlight += 1;
			const generation = this.generation;
			const previous = this.pages[request.directory] ?? { data: null, loading: false, error: null };
			void this.fetchDirectory(request, previous.data, generation)
				.then((result) => {
					if (!this.active || generation !== this.generation) return null;
					if (!result) {
						this.pages = { ...this.pages, [request.directory]: { ...previous, loading: false } };
						return null;
					}
					this.loadedPageCounts.set(request.directory, result.count);
					this.pages = {
						...this.pages,
						[request.directory]: {
							data: result.data,
							loading: false,
							error: null,
						},
					};
					return result.data;
				})
				.catch((error: unknown) => {
					if (this.active && generation === this.generation) {
						this.pages = {
							...this.pages,
							[request.directory]: {
								...previous,
								loading: false,
								error: error instanceof Error ? error : new Error(String(error)),
							},
						};
					}
					return null;
				})
				.then((page) => {
					this.inFlight -= 1;
					if (generation === this.generation) {
						this.pending.delete(request.directory);
						if (this.active) this.publish();
					}
					request.resolve(page);
					this.drain();
				});
		}
	}
}
