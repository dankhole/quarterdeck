import { writeFile } from "node:fs/promises";

import { buildPiLifecycleExtensionSource } from "../../src/terminal/pi-lifecycle-extension";

const destination = process.argv[2];
if (!destination) throw new Error("Expected an isolated launch asset destination.");
await writeFile(destination, buildPiLifecycleExtensionSource());
