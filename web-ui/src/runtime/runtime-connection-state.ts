/**
 * Module-level flag tracking whether the runtime WebSocket is disconnected.
 *
 * This lives outside React state so that the AppErrorBoundary fallback can
 * read it synchronously. When the server shuts down, the WebSocket `onclose`
 * fires and sets this flag *before* React re-renders. If a render error is
 * caught by the error boundary, the fallback checks this flag and shows the
 * "Disconnected" UI instead of the generic crash screen.
 */

let disconnected = false;

export function setRuntimeDisconnected(value: boolean): void {
	disconnected = value;
}

export function isRuntimeDisconnected(): boolean {
	return disconnected;
}
