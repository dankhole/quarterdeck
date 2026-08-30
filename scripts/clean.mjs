import { rm } from "node:fs/promises";

await Promise.all([
	rm("dist", { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	rm("coverage", { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
]);
