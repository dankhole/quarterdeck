// Defense in depth, not an OS sandbox: only the smoke's exact hook recorder may
// receive Node TCP connections. No inherited NODE_OPTIONS or credentials survive.
const fs = require("node:fs");
const net = require("node:net");
const { syncBuiltinESMExports } = require("node:module");
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	let options = args[0];
	if (Array.isArray(options)) options = options[0];
	const port = typeof options === "object" ? options.port : options;
	const host = typeof options === "object" ? options.host : args[1];
	if (host !== "127.0.0.1" || String(port) !== process.env.PI_SMOKE_HOOK_PORT) {
		fs.appendFileSync(process.env.PI_SMOKE_NETWORK_AUDIT, "Blocked unexpected network connection\n");
		throw new Error("Native Pi smoke forbids network access outside its hook recorder");
	}
	return original.apply(this, args);
};
syncBuiltinESMExports();
