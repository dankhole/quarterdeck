process.on("message", (message) => {
	if (!message || typeof message !== "object") {
		return;
	}

	if (message.type !== "quarterdeck.shutdown") {
		return;
	}

	process.emit("SIGINT");
});
