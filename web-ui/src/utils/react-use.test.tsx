import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { build, loadConfigFromFile } from "vite";
import { describe, expect, it, vi } from "vitest";
import type * as HookAdapters from "./react-use";

describe("production react-use imports", () => {
	it("mounts the bundled hook adapters and runs their effects", async () => {
		// Source tests resolve CommonJS differently from the production bundler.
		// Use the real build configuration so import interop and minification are covered.
		const loaded = await loadConfigFromFile(
			{ command: "build", mode: "production" },
			resolve(import.meta.dirname, "../..", "vite.config.ts"),
		);
		if (!loaded) throw new Error("Expected the production build configuration.");
		const result = await build({
			...loaded.config,
			configFile: false,
			logLevel: "silent",
			build: {
				...loaded.config.build,
				write: false,
				sourcemap: false,
				lib: { entry: resolve(import.meta.dirname, "react-use.ts"), name: "QuarterdeckHooks", formats: ["iife"] },
				rollupOptions: {
					external: ["react"],
					output: {
						globals: { react: "React" },
						footer: "globalThis.__quarterdeckBundledHooks = QuarterdeckHooks;",
					},
				},
			},
		});
		if ("close" in result) throw new Error("Expected a completed production build.");
		const outputs = Array.isArray(result) ? result : [result];
		const chunk = outputs.flatMap((output) => output.output).find((output) => output.type === "chunk");
		if (chunk?.type !== "chunk") throw new Error("Expected a bundled hook module.");
		vi.useFakeTimers();
		const hooks = runInNewContext(`${chunk.code}\nglobalThis.__quarterdeckBundledHooks;`, {
			React,
			require: (id: string) => {
				if (id !== "react") throw new Error(`Unexpected external module: ${id}`);
				return React;
			},
			window,
			document,
			setTimeout,
			clearTimeout,
			setInterval,
			clearInterval,
		}) as typeof HookAdapters;
		const onWindowEvent = vi.fn();
		const onDocumentEvent = vi.fn();
		const onDebounce = vi.fn();
		const onInterval = vi.fn();
		const onUnmount = vi.fn();
		const originalTitle = document.title;
		const container = document.createElement("div");
		const root = createRoot(container);
		const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
		const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
		actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
		try {
			function HookHarness() {
				hooks.useWindowEvent("resize", onWindowEvent);
				hooks.useDocumentEvent("visibilitychange", onDocumentEvent);
				hooks.useInterval(onInterval, 10);
				hooks.useDebouncedEffect(onDebounce, 10, []);
				hooks.useDocumentTitle("Bundled hook smoke test");
				hooks.useUnmount(onUnmount);
				const [ref, rect] = hooks.useMeasure<HTMLDivElement>();
				expect(typeof ref).toBe("function");
				expect(rect.width).toBe(0);
				return <div ref={ref} />;
			}
			await act(async () => root.render(<HookHarness />));
			expect(document.title).toBe("Bundled hook smoke test");
			act(() => {
				window.dispatchEvent(new Event("resize"));
				document.dispatchEvent(new Event("visibilitychange"));
				vi.advanceTimersByTime(10);
			});
			expect(onWindowEvent).toHaveBeenCalledOnce();
			expect(onDocumentEvent).toHaveBeenCalledOnce();
			expect(onInterval).toHaveBeenCalledOnce();
			expect(onDebounce).toHaveBeenCalledOnce();
			act(() => root.unmount());
			expect(onUnmount).toHaveBeenCalledOnce();
			window.dispatchEvent(new Event("resize"));
			document.dispatchEvent(new Event("visibilitychange"));
			vi.advanceTimersByTime(20);
			expect(onWindowEvent).toHaveBeenCalledOnce();
			expect(onDocumentEvent).toHaveBeenCalledOnce();
			expect(onInterval).toHaveBeenCalledOnce();
		} finally {
			act(() => root.unmount());
			actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
			vi.useRealTimers();
			document.title = originalTitle;
		}
	}, 30_000);
});
