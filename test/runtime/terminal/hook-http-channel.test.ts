import { describe, expect, it } from "vitest";

import {
	buildLoopbackProxyBypassEnv,
	HookHttpChannel,
	QUARTERDECK_HOOK_HTTP_TOKEN_ENV,
} from "../../../src/terminal/hook-http-channel";

const identity = { taskId: "task-1", projectId: "project-1", sessionInstanceId: "instance-1" };

describe("HookHttpChannel", () => {
	it("offers the HTTP transport only while an endpoint is published", () => {
		const channel = new HookHttpChannel();
		expect(channel.prepareLaunch(identity)).toBeNull();

		channel.publishEndpoint("http://127.0.0.1:43123");
		const launch = channel.prepareLaunch(identity);
		expect(launch?.transport.url).toBe("http://127.0.0.1:43123/api/hooks/notify");
		expect(channel.prepareLaunch(identity, {})?.env).toEqual({
			[QUARTERDECK_HOOK_HTTP_TOKEN_ENV]: channel.mintCredential(identity),
			NO_PROXY: "127.0.0.1,localhost,::1",
			no_proxy: "127.0.0.1,localhost,::1",
		});
		expect(launch?.env[QUARTERDECK_HOOK_HTTP_TOKEN_ENV]).toBe(channel.mintCredential(identity));

		channel.withdrawEndpoint();
		expect(channel.prepareLaunch(identity)).toBeNull();
	});

	it("binds a credential to the exact task-session identity", () => {
		const channel = new HookHttpChannel();
		const credential = channel.mintCredential(identity);

		expect(channel.verifyCredential(identity, credential)).toBe(true);
		expect(channel.verifyCredential({ ...identity, taskId: "task-2" }, credential)).toBe(false);
		expect(channel.verifyCredential({ ...identity, projectId: "project-2" }, credential)).toBe(false);
		expect(channel.verifyCredential({ ...identity, sessionInstanceId: "instance-2" }, credential)).toBe(false);
		expect(channel.verifyCredential({ ...identity, sessionInstanceId: null }, credential)).toBe(false);
		const tampered = `${credential.slice(0, -1)}${credential.endsWith("A") ? "B" : "A"}`;
		expect(channel.verifyCredential(identity, tampered)).toBe(false);
		expect(channel.verifyCredential(identity, undefined)).toBe(false);
		expect(channel.verifyCredential(identity, "")).toBe(false);
	});

	it("rejects credentials minted by another runtime process", () => {
		const credential = new HookHttpChannel().mintCredential(identity);
		expect(new HookHttpChannel().verifyCredential(identity, credential)).toBe(false);
	});

	it("does not let delimiter choices alias two identities", () => {
		const channel = new HookHttpChannel();
		const credential = channel.mintCredential({ taskId: "a", projectId: "b,c" });
		expect(channel.verifyCredential({ taskId: "a,b", projectId: "c" }, credential)).toBe(false);
	});
});

describe("buildLoopbackProxyBypassEnv", () => {
	it("appends loopback to both proxy bypass spellings without dropping either existing list", () => {
		expect(
			buildLoopbackProxyBypassEnv({ NO_PROXY: "corp.example, .internal", no_proxy: "localhost,build.local" }),
		).toEqual({
			NO_PROXY: "corp.example,.internal,localhost,build.local,127.0.0.1,::1",
			no_proxy: "corp.example,.internal,localhost,build.local,127.0.0.1,::1",
		});
	});

	it("adds only loopback when no bypass list is inherited", () => {
		expect(buildLoopbackProxyBypassEnv({ HTTPS_PROXY: "http://proxy.example:8080" })).toEqual({
			NO_PROXY: "127.0.0.1,localhost,::1",
			no_proxy: "127.0.0.1,localhost,::1",
		});
	});
});
