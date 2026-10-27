import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenCodeEvent, SessionID, SessionInfo } from "@opencode/client";
import type { Plugin } from "@opencode/plugin";
import type { Plugin as TuiPlugin } from "@opencode/plugin/tui";
import type { Route } from "@opencode/plugin/tui/context";
import { Host } from "@opencode/plugin/host";
import SimpleNotificationPlugin from "../index";
import SimpleNotificationTuiPlugin from "../tui";
import { NotificationRpc } from "../rpc";
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

	function createMockServerContext(
		channel: ReturnType<typeof createEventChannel>,
		options: Record<string, unknown> = { delay: 0.01 },
	) {
		let promptHook: ((event: { sessionID: SessionID }) => Promise<void> | void) | undefined;
		let registeredRpcHandlers: Record<string, () => Promise<unknown>> | undefined;
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
			rpc: Object.assign(() => ({}), {
				register: mock(async (_def: unknown, handlers: Record<string, () => Promise<unknown>>) => {
					registeredRpcHandlers = handlers;
					return { dispose: async () => {}, events: { emit: async () => {} } };
				}),
			}),
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

		return {
			ctx,
			getPromptHook: () => promptHook,
			getRpcHandlers: () => registeredRpcHandlers,
		};
	}

	function createMockTuiContext(
		options: {
			inlineOptions?: Record<string, unknown>;
			serverOptions?: Record<string, unknown>;
			route?: () => Route;
			tabsEnabled?: boolean;
			openTabs?: string[];
			sessions?: Record<string, Partial<SessionInfo>>;
		} = {},
	) {
		const listeners = new Set<(event: { details: OpenCodeEvent }) => void>();
		const toasts: Array<{ message: string; variant?: string }> = [];
		const sessionsMap = options.sessions ?? {};

		const resolveSession = (sessionID: string): SessionInfo =>
			({
				id: sessionID as SessionID,
				title: sessionsMap[sessionID]?.title ?? `Title for ${sessionID}`,
				parentID: sessionsMap[sessionID]?.parentID as SessionID | undefined,
				location: sessionsMap[sessionID]?.location ?? {
					directory: path.join(tempDir, "my-project"),
				},
			}) as SessionInfo;

		const resolveRoot = (sessionID: string): string => {
			let current = sessionID;
			const seen = new Set<string>([current]);
			while (sessionsMap[current]?.parentID) {
				const parent = sessionsMap[current]!.parentID!;
				if (seen.has(parent)) break;
				seen.add(parent);
				current = parent;
			}
			return current;
		};

		const context = {
			options: options.inlineOptions ?? { delay: 0.01 },
			location: { directory: path.join(tempDir, "my-project") },
			client: {
				rpc: (def: unknown) => {
					if (def === NotificationRpc && options.serverOptions !== undefined) {
						return {
							getOptions: async () => ({ options: options.serverOptions! }),
						};
					}
					return {
						getOptions: async () => {
							throw new Error("rpc.unavailable");
						},
					};
				},
				session: {
					get: mock(async ({ sessionID }: { sessionID: SessionID }) => resolveSession(sessionID)),
				},
			},
			data: {
				listen: (handler: (event: { details: OpenCodeEvent }) => void) => {
					listeners.add(handler);
					return () => listeners.delete(handler);
				},
				location: {
					default: () => ({ directory: path.join(tempDir, "my-project") }),
				},
				session: {
					get: (sessionID: string) => resolveSession(sessionID),
					root: (sessionID: string) => resolveRoot(sessionID),
				},
			},
			ui: {
				toast: {
					show: (toast: { message: string; variant?: string }) => {
						toasts.push(toast);
					},
				},
				router: {
					current: options.route ?? (() => ({ type: "session", sessionID: "ses_1" })),
				},
				tabs: {
					enabled: () => options.tabsEnabled ?? false,
					list: () =>
						(options.openTabs ?? []).map((sessionID) => ({
							sessionID,
							active: false,
							busy: false,
							attention: false,
						})),
				},
			},
		} as unknown as TuiPlugin.Context;

		const emit = (event: OpenCodeEvent) => {
			for (const listener of listeners) {
				listener({ details: event });
			}
		};

		return {
			context,
			emit,
			toasts,
			listenerCount: () => listeners.size,
		};
	}

	it("exports valid V2 server, TUI, and RPC plugin definitions", () => {
		expect(SimpleNotificationPlugin.id).toBe("opencode-notification");
		expect(typeof SimpleNotificationPlugin.setup).toBe("function");
		expect(SimpleNotificationTuiPlugin.id).toBe("opencode-notification");
		expect(typeof SimpleNotificationTuiPlugin.setup).toBe("function");
		expect(NotificationRpc.id).toBe("opencode-notification");

		const repoRoot = path.resolve(import.meta.dir, "..");
		const entrypoints = Host.resolve({ directory: repoRoot });
		expect(entrypoints.server).toBeDefined();
		expect(entrypoints.tui).toBeDefined();
		expect(entrypoints.rpc).toBeDefined();
	});

	it("loads config and merges multiple inline option layers over file config", async () => {
		await Bun.write(
			path.join(tempDir, "oc-notification.json"),
			JSON.stringify({ delay: 20, enabled: true, error: { enabled: false } }),
		);
		const config = await loadConfig(
			tempDir,
			{ delay: 5, permission_asked: { enabled: false } },
			{ permission_asked: { enabled: true } },
		);
		const resolved = createResolvedConfig(config);

		expect(resolved.getDelay("session.idle")).toBe(5000);
		expect(resolved.isEnabled("session.execution.succeeded")).toBe(true);
		expect(resolved.isEnabled("session.execution.failed")).toBe(false);
		expect(resolved.isEnabled("permission.asked")).toBe(true);
		expect(resolved.isEnabled("form.created")).toBe(true);
	});

	it("shows a TUI error toast and throws ConfigError on invalid JSON config", async () => {
		const projectDir = path.join(tempDir, "my-project");
		await Bun.write(path.join(projectDir, "oc-notification.json"), "{ invalid json");
		const { context, toasts } = createMockTuiContext();

		await expect(SimpleNotificationTuiPlugin.setup(context)).rejects.toThrow(ConfigError);
		expect(toasts).toHaveLength(1);
		expect(toasts[0]?.variant).toBe("error");
		expect(toasts[0]?.message).toContain("Notification plugin config error:");
	});

	it("TUI plugin notifies on session.execution.succeeded and permission.asked", async () => {
		const { context, emit, listenerCount } = createMockTuiContext({
			inlineOptions: {},
			serverOptions: { delay: 0.01 },
			route: () => ({ type: "session", sessionID: "ses_1" }),
		});
		const cleanup = await SimpleNotificationTuiPlugin.setup(context);

		emit({
			type: "permission.asked",
			data: {
				id: "perm_1",
				sessionID: "ses_1" as SessionID,
				action: "shell",
				resources: ["ls"],
			},
		} as unknown as OpenCodeEvent);

		await Bun.sleep(30);
		expect(notifySpy).toHaveBeenCalledTimes(1);
		expect(notifySpy).toHaveBeenCalledWith({
			title: "Permission Asked",
			message: "Title for ses_1 in my-project needs permission",
		});

		notifySpy.mockClear();

		emit({
			type: "session.execution.started",
			data: { sessionID: "ses_1" as SessionID },
		} as OpenCodeEvent);
		emit({
			type: "session.execution.succeeded",
			data: { sessionID: "ses_1" as SessionID },
		} as OpenCodeEvent);
		emit({
			type: "session.idle",
			data: { sessionID: "ses_1" as SessionID },
		} as OpenCodeEvent);

		await Bun.sleep(30);
		expect(notifySpy).toHaveBeenCalledTimes(1);
		expect(notifySpy).toHaveBeenCalledWith({
			title: "Response ready",
			message: "Title for ses_1",
		});

		await cleanup?.();
		expect(listenerCount()).toBe(0);
	});

	it("TUI plugin suppresses Response ready for subagents but notifies when subagents ask for permission", async () => {
		const { context, emit } = createMockTuiContext({
			inlineOptions: { delay: 0.01 },
			route: () => ({ type: "session", sessionID: "ses_root" }),
			sessions: {
				ses_root: { title: "Root Session" },
				ses_sub: { title: "Subagent Task", parentID: "ses_root" as SessionID },
			},
		});
		const cleanup = await SimpleNotificationTuiPlugin.setup(context);

		// Subagent finishes while root session is still running -> should NOT notify Response ready
		emit({
			type: "session.execution.started",
			data: { sessionID: "ses_sub" as SessionID },
		} as OpenCodeEvent);
		emit({
			type: "session.execution.succeeded",
			data: { sessionID: "ses_sub" as SessionID },
		} as OpenCodeEvent);

		await Bun.sleep(30);
		expect(notifySpy).toHaveBeenCalledTimes(0);

		// Subagent asks for permission -> SHOULD notify because it blocks the root session
		emit({
			type: "permission.asked",
			data: {
				id: "perm_sub",
				sessionID: "ses_sub" as SessionID,
				action: "shell",
				resources: ["git status"],
			},
		} as unknown as OpenCodeEvent);

		await Bun.sleep(30);
		expect(notifySpy).toHaveBeenCalledTimes(1);
		expect(notifySpy).toHaveBeenCalledWith({
			title: "Permission Asked",
			message: "Subagent Task in my-project needs permission",
		});

		await cleanup?.();
	});

	it("TUI plugin scopes notifications to the active session pane when tabs are disabled", async () => {
		const { context, emit } = createMockTuiContext({
			inlineOptions: { delay: 0.01 },
			route: () => ({ type: "session", sessionID: "ses_pane_1" }),
			tabsEnabled: false,
		});
		const cleanup = await SimpleNotificationTuiPlugin.setup(context);

		// Event from another pane's session -> ignored by this pane
		emit({
			type: "session.execution.succeeded",
			data: { sessionID: "ses_pane_2" as SessionID },
		} as OpenCodeEvent);

		await Bun.sleep(30);
		expect(notifySpy).toHaveBeenCalledTimes(0);

		// Event for this pane's session -> notifies
		emit({
			type: "session.execution.succeeded",
			data: { sessionID: "ses_pane_1" as SessionID },
		} as OpenCodeEvent);

		await Bun.sleep(30);
		expect(notifySpy).toHaveBeenCalledTimes(1);

		await cleanup?.();
	});

	it("server plugin forwards options via RPC and suppresses duplicate server-side notifications once TUI connects", async () => {
		const channel = createEventChannel();
		const { ctx, getRpcHandlers } = createMockServerContext(channel, { delay: 0.01 });
		const cleanup = await SimpleNotificationPlugin.setup(ctx);

		const rpcResponse = await getRpcHandlers()?.getOptions?.();
		expect(rpcResponse).toEqual({ options: { delay: 0.01 } });

		// Once TUI has connected via RPC, server-side scheduling is suppressed
		channel.push({
			type: "session.execution.succeeded",
			data: { sessionID: "ses_1" as SessionID },
		} as OpenCodeEvent);

		await Bun.sleep(30);
		expect(notifySpy).toHaveBeenCalledTimes(0);

		await cleanup?.();
	});

	it("notifies on session.execution.failed and suppresses subsequent session.idle", async () => {
		const channel = createEventChannel();
		const { ctx } = createMockServerContext(channel, { delay: 0.01 });
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
		const { ctx } = createMockServerContext(channel, { delay: 0.05 });
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
		const { ctx } = createMockServerContext(channel, { delay: 0.01 });
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
		const { ctx, getPromptHook } = createMockServerContext(channel, { delay: 0.01 });
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

	it("writes BEL (\\x07) to stdout TTY or falls back to stderr TTY in Notification.notify", () => {
		Notification.notify = originalNotify;
		const originalStdoutIsTTY = process.stdout.isTTY;
		const originalStderrIsTTY = process.stderr.isTTY;
		const originalStdoutWrite = process.stdout.write;
		const originalStderrWrite = process.stderr.write;
		const originalWhich = Bun.which;

		const stdoutWrites: string[] = [];
		const stderrWrites: string[] = [];

		try {
			Bun.which = (() => null) as typeof Bun.which;
			process.stdout.write = ((chunk: string | Uint8Array) => {
				stdoutWrites.push(String(chunk));
				return true;
			}) as typeof process.stdout.write;
			process.stderr.write = ((chunk: string | Uint8Array) => {
				stderrWrites.push(String(chunk));
				return true;
			}) as typeof process.stderr.write;

			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
			Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });

			Notification.notify({ title: "Permission Asked", message: "Needs permission" });
			expect(stdoutWrites).toEqual(["\x07"]);
			expect(stderrWrites).toEqual([]);

			Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
			Notification.notify({ title: "Response ready", message: "Done" });
			expect(stderrWrites).toEqual(["\x07"]);
		} finally {
			Bun.which = originalWhich;
			process.stdout.write = originalStdoutWrite;
			process.stderr.write = originalStderrWrite;
			Object.defineProperty(process.stdout, "isTTY", {
				value: originalStdoutIsTTY,
				configurable: true,
			});
			Object.defineProperty(process.stderr, "isTTY", {
				value: originalStderrIsTTY,
				configurable: true,
			});
		}
	});
});
