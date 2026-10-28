import { Plugin } from "@opencode/plugin";
import type { SessionID } from "@opencode/client";
import { NotificationRpc } from "./rpc";
import { createNotificationScheduler } from "@/notification-scheduler";
import { createNotificationEventHandler, type SessionDetails } from "@/event-handler";
import { loadConfig, ConfigError, isAutoAcceptMode } from "@/config/loader";
import { createResolvedConfig } from "@/config/resolver";
import { createLogger } from "@/logger";

const logger = createLogger("opencode-notification");

export const SimpleNotificationPlugin = Plugin.define({
	id: "opencode-notification",
	async setup(ctx) {
		const inlineOptions =
			ctx.options && typeof ctx.options === "object" && !Array.isArray(ctx.options)
				? (ctx.options as Record<string, unknown>)
				: undefined;

		const config = await loadConfig(ctx.location.directory, inlineOptions).catch((error) => {
			const message =
				error instanceof ConfigError
					? `Notification plugin config error: ${error.message}`
					: `Notification plugin failed to load: ${error instanceof Error ? error.message : String(error)}`;
			logger.error(message);
			throw error;
		});

		const resolvedConfig = createResolvedConfig(config);
		const scheduler = createNotificationScheduler(resolvedConfig);

		// In OpenCode V2, `opencode serve --service` runs as a detached background
		// daemon with `stdout -> /dev/null`, so terminal bells (`\x07`) and terminal
		// process detection must run inside the TUI plugin (`./tui`). Once a TUI
		// plugin instance connects over RPC to fetch options, suppress server-side
		// notification scheduling so desktop notifications do not fire twice.
		let tuiConnected = false;

		await ctx.rpc?.register?.(NotificationRpc, {
			getOptions: async () => {
				tuiConnected = true;
				scheduler.cancelAll();
				return { options: inlineOptions ?? {} };
			},
		});

		const getSessionDetails = async (
			sessionId: string,
			fallbackDirectory?: string,
		): Promise<SessionDetails> => {
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
				parentID: session?.parentID,
			};
		};

		const handler = createNotificationEventHandler({
			scheduler,
			getSessionDetails,
			isSuppressed: () => tuiConnected,
			isAutoAccept: (directory) => isAutoAcceptMode(directory ?? ctx.location.directory),
		});

		await ctx.session.hook("prompt", (event) => {
			handler.onPrompt(event.sessionID);
		});

		const controller = new AbortController();
		void (async () => {
			try {
				for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
					await handler.handleEvent(event);
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
			handler.dispose();
		};
	},
});

export default SimpleNotificationPlugin;
