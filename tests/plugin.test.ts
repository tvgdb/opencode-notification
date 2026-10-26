import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenCodeEvent, SessionID } from "@opencode/client";
import type { Plugin } from "@opencode/plugin";
import SimpleNotificationPlugin from "../index";
import { Notification } from "@/notification";
import { loadConfig, ConfigError } from "@/config/loader";
import { createResolvedConfig } from "@/config/resolver";

function createEventChannel() {
	const queue: OpenCodeEvent[] = [];
	let resolveNext: ((result: IteratorResult<OpenCodeEvent>) => void) | null = null;
	let closed = false;

	const push = (event: OpenCodeEvent) => {
		if (closed) return;
		if (resolveNext) {
			const resolve = resolveNext;
			resolveNext = null;
			resolve({ value: event, done: false });
		} else {
			queue.push(event);
		}
	};

	const close = () => {
		closed = true;
		if (resolveNext) {
			const resolve = resolveNext;
			resolveNext = null;
			resolve({ value: undefined as unknown as OpenCodeEvent, done: true });
		}
	};

	const subscribe = ({ signal }: { signal?: AbortSignal } = {}): AsyncIterable<OpenCodeEvent> => {
		signal?.addEventListener("abort", () => close(), { once: true });
		return {
			[Symbol.asyncIterator]() {
				return {
					next(): Promise<IteratorResult<OpenCodeEvent>> {
						if (queue.length > 0) {
							return Promise.resolve({ value: queue.shift()!, done: false });
						}
						if (closed || signal?.aborted) {
							return Promise.resolve({
								value: undefined as unknown as OpenCodeEvent,
								done: true,
							});
						}
						return new Promise((resolve) => {
							resolveNext = resolve;
						});
					},
					return(): Promise<IteratorResult<OpenCodeEvent>> {
						close();
						return Promise.resolve({
							value: undefined as unknown as OpenCodeEvent,
							done: true,
						});
					},
				};
			},
		};
	};

	return { push, close, subscribe, isClosed: () => closed };
}

describe("opencode-notification V2 plugin", () => {
	let tempDir: string;
	let notifySpy: ReturnType<typeof mock>;
	const originalNotify = Notification.notify;

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "oc-notification-test-"));
		notifySpy = mock(() => {});
		Notification.notify = notifySpy;
	});

	afterEach(async () => {
		Notification.notify = originalNotify;
		await rm(tempDir, { recursive: true, force: true });
	});

	function createMockContext(
		channel: ReturnType<typeof createEventChannel>,
		options: Record<string, unknown> = { delay: 0.01 },
	) {
		let promptHook: ((event: { sessionID: SessionID }) => Promise<void> | void) | undefined;
		const ctx = {
			location: {
				directory: tempDir,
				project: {
					id: "proj_test",
					directory: tempDir,
					canonical: tempDir,
				},
			},
			options,
			event: {
				subscribe: channel.subscribe,
			},
			session: {
				get: mock(async ({ sessionID }: { sessionID: SessionID }) => ({
					id: sessionID,
					title: `Title for ${sessionID}`,
					location: { directory: path.join(tempDir, "my-project") },
				})),
				hook: mock(async (name: string, cb: (event: { sessionID: SessionID }) => void) => {
					if (name === "prompt") {
						promptHook = cb;
					}
					return { dispose: async () => {} };
				}),
			},
		} as unknown as Plugin.Context;

		return { ctx, getPromptHook: () => promptHook };
	}

	it("exports a valid V2 plugin definition", () => {
		expect(SimpleNotificationPlugin.id).toBe("opencode-notification");
		expect(typeof SimpleNotificationPlugin.setup).toBe("function");
	});

	it("loads config and merges inline options over file config", async () => {
		await Bun.write(
			path.join(tempDir, "oc-notification.json"),
			JSON.stringify({ delay: 20, enabled: true, error: { enabled: false } }),
		);
		const config = await loadConfig(tempDir, { delay: 5 });
		const resolved = createResolvedConfig(config);

		expect(resolved.getDelay("session.idle")).toBe(5000);
		expect(resolved.isEnabled("session.execution.succeeded")).toBe(true);
		expect(resolved.isEnabled("session.execution.failed")).toBe(false);
		expect(resolved.isEnabled("form.created")).toBe(true);
	});

	it("throws ConfigError on invalid JSON config", async () => {
		await Bun.write(path.join(tempDir, "oc-notification.json"), "{ invalid json");
		const channel = createEventChannel();
		const { ctx } = createMockContext(channel);

		await expect(SimpleNotificationPlugin.setup(ctx)).rejects.toThrow(ConfigError);
	});

	it("notifies once on session.execution.succeeded and does not duplicate on session.idle", async () => {
		const channel = createEventChannel();
		const { ctx } = createMockContext(channel, { delay: 0.01 });
		const cleanup = await SimpleNotificationPlugin.setup(ctx);

		channel.push({
			type: "session.execution.started",
			data: { sessionID: "ses_1" as SessionID },
		} as OpenCodeEvent);
		channel.push({
			type: "session.execution.succeeded",
			data: { sessionID: "ses_1" as SessionID },
		} as OpenCodeEvent);
		channel.push({
			type: "session.idle",
			data: { sessionID: "ses_1" as SessionID },
		} as OpenCodeEvent);

		await Bun.sleep(40);

		expect(notifySpy).toHaveBeenCalledTimes(1);
		expect(notifySpy).toHaveBeenCalledWith({
			title: "Response ready",
			message: "Title for ses_1",
		});

		await cleanup?.();
		expect(channel.isClosed()).toBe(true);
	});

	it("notifies on session.execution.failed and suppresses subsequent session.idle", async () => {
		const channel = createEventChannel();
		const { ctx } = createMockContext(channel, { delay: 0.01 });
		const cleanup = await SimpleNotificationPlugin.setup(ctx);

		channel.push({
			type: "session.step.started",
			data: { sessionID: "ses_err" as SessionID },
		} as unknown as OpenCodeEvent);
		channel.push({
			type: "session.execution.failed",
			data: {
				sessionID: "ses_err" as SessionID,
				error: { type: "ProviderError", message: "Rate limit" },
			},
		} as unknown as OpenCodeEvent);
		channel.push({
			type: "session.idle",
			data: { sessionID: "ses_err" as SessionID },
		} as OpenCodeEvent);

		await Bun.sleep(40);

		expect(notifySpy).toHaveBeenCalledTimes(1);
		expect(notifySpy).toHaveBeenCalledWith({
			title: "Session error",
			message: "Title for ses_err",
		});

		await cleanup?.();
	});

	it("handles permission.asked and cancels when permission.replied is approved", async () => {
		const channel = createEventChannel();
		const { ctx } = createMockContext(channel, { delay: 0.05 });
		const cleanup = await SimpleNotificationPlugin.setup(ctx);

		channel.push({
			type: "permission.asked",
			data: {
				id: "perm_1",
				sessionID: "ses_perm" as SessionID,
				action: "shell",
				resources: ["rm -rf"],
			},
		} as unknown as OpenCodeEvent);

		await Bun.sleep(10);
		channel.push({
			type: "permission.replied",
			data: {
				sessionID: "ses_perm" as SessionID,
				requestID: "perm_1",
				reply: "once",
			},
		} as unknown as OpenCodeEvent);

		await Bun.sleep(60);
		expect(notifySpy).toHaveBeenCalledTimes(0);

		await cleanup?.();
	});

	it("notifies on form.created (V2 question) and suppresses idle on form.cancelled", async () => {
		const channel = createEventChannel();
		const { ctx } = createMockContext(channel, { delay: 0.01 });
		const cleanup = await SimpleNotificationPlugin.setup(ctx);

		channel.push({
			type: "form.created",
			data: {
				form: {
					id: "frm_1",
					sessionID: "ses_q",
					title: "Clarify",
					fields: [],
				},
			},
		} as unknown as OpenCodeEvent);

		await Bun.sleep(30);
		expect(notifySpy).toHaveBeenCalledTimes(1);
		expect(notifySpy).toHaveBeenCalledWith({
			title: "Question",
			message: "Title for ses_q in my-project has a question",
		});

		notifySpy.mockClear();

		channel.push({
			type: "session.step.started",
			data: { sessionID: "ses_q" as SessionID },
		} as unknown as OpenCodeEvent);
		channel.push({
			type: "form.cancelled",
			data: { id: "frm_1", sessionID: "ses_q" },
		} as unknown as OpenCodeEvent);
		channel.push({
			type: "session.idle",
			data: { sessionID: "ses_q" as SessionID },
		} as OpenCodeEvent);

		await Bun.sleep(30);
		expect(notifySpy).toHaveBeenCalledTimes(0);

		await cleanup?.();
	});

	it("suppresses notification when session.execution.interrupted fires", async () => {
		const channel = createEventChannel();
		const { ctx, getPromptHook } = createMockContext(channel, { delay: 0.01 });
		const cleanup = await SimpleNotificationPlugin.setup(ctx);

		channel.push({
			type: "session.execution.started",
			data: { sessionID: "ses_int" as SessionID },
		} as OpenCodeEvent);
		channel.push({
			type: "session.execution.interrupted",
			data: { sessionID: "ses_int" as SessionID, reason: "user" },
		} as OpenCodeEvent);
		channel.push({
			type: "session.idle",
			data: { sessionID: "ses_int" as SessionID },
		} as OpenCodeEvent);

		await Bun.sleep(30);
		expect(notifySpy).toHaveBeenCalledTimes(0);

		// Subsequent prompt hook resets interrupted state
		await getPromptHook()?.({ sessionID: "ses_int" as SessionID });
		channel.push({
			type: "session.step.started",
			data: { sessionID: "ses_int" as SessionID },
		} as unknown as OpenCodeEvent);
		channel.push({
			type: "session.execution.succeeded",
			data: { sessionID: "ses_int" as SessionID },
		} as OpenCodeEvent);

		await Bun.sleep(30);
		expect(notifySpy).toHaveBeenCalledTimes(1);

		await cleanup?.();
	});
});
