/**
 * Universal cleanup contract — equivalent to C#'s System.IDisposable.
 * Every resource that needs cleanup implements this interface.
 */
export interface IDisposable {
	dispose(): void;
}

/** Wraps any cleanup function as an IDisposable. */
export function toDisposable(dispose: () => void): IDisposable {
	let disposed = false;
	return {
		dispose: () => {
			if (disposed) return;
			disposed = true;
			dispose();
		},
	};
}

/**
 * Collects multiple IDisposable instances and disposes them all at once.
 * Equivalent to C#'s CompositeDisposable.
 */
export class DisposableStore implements IDisposable {
	private readonly items: IDisposable[] = [];
	private disposed = false;

	add<T extends IDisposable>(disposable: T): T {
		if (this.disposed) {
			disposable.dispose();
			return disposable;
		}
		this.items.push(disposable);
		return disposable;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		// Dispose in reverse order (LIFO) — matches C# convention
		for (const item of this.items.splice(0).reverse()) {
			try {
				item.dispose();
			} catch {
				// Swallow errors during cleanup — same as C# Dispose()
			}
		}
	}
}

/**
 * Base class for services that own disposable resources.
 * Subclasses call this._register() to track resources; all are
 * cleaned up automatically when dispose() is called.
 *
 * Equivalent to VS Code's Disposable base class.
 */
export abstract class Disposable implements IDisposable {
	private readonly _store = new DisposableStore();

	protected _register<T extends IDisposable>(disposable: T): T {
		return this._store.add(disposable);
	}

	dispose(): void {
		this._store.dispose();
	}
}
