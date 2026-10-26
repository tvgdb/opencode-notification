import path from "node:path";
import { Plugin } from "@opencode/plugin";
import type { OpenCodeEvent, SessionID } from "@opencode/client";
import { createNotificationScheduler } from "@/notification-scheduler";
import { loadConfig, ConfigError } from "@/config/loader";
import { createResolvedConfig } from "@/config/resolver";
import { createLogger } from "@/logger";

const logger = createLogger("opencode-notification");

export const SimpleNotificationPlugin = Plugin.define({
	id: "opencode-notification",
	async setup(ctx) {
		const config = await loadConfig(ctx.location.directory, ctx.options).catch((error) => {
			const message =
				error instanceof ConfigError
					? `Notification plugin config error: ${error.message}`
					: `Notification plugin failed to load: ${error instanceof Error ? error.message : String(error)}`;
			logger.error(message);
			throw error;
		});

		const resolvedConfig = createResolvedConfig(config);
		const scheduler = createNotificationScheduler(resolvedConfig);
		// Tracks sessions where assistant has responded since last user message
		const activeSessions = new Set<string>();
		// Tracks sessions interrupted explicitly by user command
		const interruptedSessions = new Set<string>();

		const cancelForSession = (sessionId: string) => {
			scheduler.cancelForSession(sessionId);
			activeSessions.delete(sessionId);
		};

		const markSessionInterrupted = (sessionId: string) => {
			interruptedSessions.add(sessionId);
			cancelForSession(sessionId);
		};

		const isDeniedReply = (response: unknown) => {
			const normalized = String(response ?? "")
				.trim()
				.toLowerCase();

			return (
				normalized.includes("deny") ||
				normalized.includes("reject") ||
				normalized.includes("interrupt") ||
				normalized.includes("cancel") ||
				normalized.includes("abort") ||
				normalized === "esc"
			);
		};

		const isAbortedError = (error?: { type?: string; name?: string; message?: string }) => {
			if (!error) return false;
			const kind = (error.type ?? error.name ?? "").toLowerCase();
			return (
				error.type === "MessageAbortedError" ||
				error.name === "MessageAbortedError" ||
				kind.includes("abort") ||
				kind.includes("interrupt")
			);
		};

		const getSessionDetails = async (sessionId: string, fallbackDirectory?: string) => {
			if (sessionId === "global") {
				return {
					title: sessionId,
					directory: fallbackDirectory ?? ctx.location.directory,
				};
			}
			const session = await ctx.session
				.get({ sessionID: sessionId as SessionID })
				.catch(() => null);
			return {
				title: session?.title ?? sessionId,
				directory: session?.location?.directory ?? fallbackDirectory ?? ctx.location.directory,
			};
		};

		await ctx.session.hook("prompt", (event) => {
			interruptedSessions.delete(event.sessionID);
			cancelForSession(event.sessionID);
		});

		const handleEvent = async (event: OpenCodeEvent) => {
			switch (event.type) {
				case "session.execution.started":
				case "session.step.started": {
					const sessionId = event.data.sessionID;
					interruptedSessions.delete(sessionId);
					scheduler.cancelForSession(sessionId);
					activeSessions.add(sessionId);
					return;
				}

				case "session.inbox.enqueued": {
					const sessionId = event.data.sessionID;
					if (event.data.item.type === "user") {
						interruptedSessions.delete(sessionId);
						cancelForSession(sessionId);
					}
					return;
				}

				case "session.inbox.delivered": {
					const sessionId = event.data.sessionID;
					interruptedSessions.delete(sessionId);
					scheduler.cancelForSession(sessionId);
					return;
				}

				case "session.execution.succeeded":
				case "session.idle": {
					const sessionId = event.data.sessionID;

					if (interruptedSessions.has(sessionId)) {
						interruptedSessions.delete(sessionId);
						activeSessions.delete(sessionId);
						return;
					}

					if (event.type === "session.idle" && !activeSessions.has(sessionId)) return;

					activeSessions.delete(sessionId);
					const { title } = await getSessionDetails(sessionId, event.location?.directory);
					scheduler.schedule(sessionId, "Response ready", title, event.type);
					return;
				}

				case "session.execution.failed":
				case "session.compaction.failed": {
					const sessionId = event.data.sessionID;
					if (!sessionId) return;

					if (isAbortedError(event.data.error)) {
						markSessionInterrupted(sessionId);
						return;
					}

					activeSessions.delete(sessionId);
					const { title } = await getSessionDetails(sessionId, event.location?.directory);
					scheduler.schedule(sessionId, "Session error", title, event.type);
					return;
				}

				case "session.execution.interrupted": {
					markSessionInterrupted(event.data.sessionID);
					return;
				}

				case "permission.asked": {
					const sessionId = event.data.sessionID;
					const { title, directory } = await getSessionDetails(
						sessionId,
						event.location?.directory,
					);
					const projectName = path.basename(directory);
					scheduler.schedule(
						sessionId,
						"Permission Asked",
						`${title} in ${projectName} needs permission`,
						"permission.asked",
					);
					return;
				}

				case "permission.replied": {
					const sessionId = event.data.sessionID;
					if (isDeniedReply(event.data.reply)) {
						markSessionInterrupted(sessionId);
					} else {
						cancelForSession(sessionId);
					}
					return;
				}

				case "form.created": {
					const sessionId = event.data.form.sessionID;
					const { title, directory } = await getSessionDetails(
						sessionId,
						event.location?.directory,
					);
					const projectName = path.basename(directory);
					scheduler.schedule(
						sessionId,
						"Question",
						`${title} in ${projectName} has a question`,
						"form.created",
					);
					return;
				}

				case "form.replied": {
					cancelForSession(event.data.sessionID);
					return;
				}

				case "form.cancelled": {
					markSessionInterrupted(event.data.sessionID);
					return;
				}

				case "session.tool.failed": {
					const errorMsg = event.data.error.message.toLowerCase();
					if (errorMsg.includes("dismissed") || isAbortedError(event.data.error)) {
						markSessionInterrupted(event.data.sessionID);
					}
					return;
				}

				case "session.status": {
					if (event.data.status.type === "busy") {
						scheduler.cancelForSession(event.data.sessionID);
					}
					return;
				}

				case "tui.prompt.append":
				case "tui.command.execute":
					return;
			}
		};

		const controller = new AbortController();
		void (async () => {
			try {
				for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
					await handleEvent(event);
				}
			} catch (error) {
				if (!controller.signal.aborted) {
					logger.error("Event subscription error", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		})();

		return () => {
			controller.abort();
			scheduler.cancelAll();
			activeSessions.clear();
			interruptedSessions.clear();
		};
	},
});

export default SimpleNotificationPlugin;
