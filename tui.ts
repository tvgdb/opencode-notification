import { Plugin } from "@opencode/plugin/tui";
import type { SessionID, SessionInfo } from "@opencode/client";
import { NotificationRpc } from "./rpc";
import { createNotificationScheduler } from "@/notification-scheduler";
import { createNotificationEventHandler, type SessionDetails } from "@/event-handler";
import { loadConfig, ConfigError } from "@/config/loader";
import { createResolvedConfig } from "@/config/resolver";
import { createLogger } from "@/logger";

const logger = createLogger("opencode-notification");

export const SimpleNotificationTuiPlugin = Plugin.define({
	id: "opencode-notification",
	async setup(context) {
		const getActiveLocation = () => context.location ?? context.data?.location?.default?.();
		const getActiveDirectory = () => getActiveLocation()?.directory ?? process.cwd();

		const initialLocation = getActiveLocation();
		const initialDirectory = getActiveDirectory();

		// OpenCode V2's `plugin.list` auto-loads `./tui` for active server plugins but
		// does not include inline `options` from `opencode.json(c)` in `PluginInfo`.
		// Query the server part over RPC so `opencode.json(c)` inline options apply in TUI.
		const serverOptions = await Promise.resolve(
			context.client
				?.rpc?.(NotificationRpc)
				?.getOptions({}, initialLocation ? { location: initialLocation } : undefined),
		)
			.then((res) => {
				const candidate = (res as { options?: unknown } | undefined)?.options;
				return candidate && typeof candidate === "object" && !Array.isArray(candidate)
					? (candidate as Record<string, unknown>)
					: undefined;
			})
			.catch(() => undefined);

		const tuiOptions =
			context.options && typeof context.options === "object" && !Array.isArray(context.options)
				? (context.options as Record<string, unknown>)
				: undefined;

		const config = await loadConfig(initialDirectory, serverOptions, tuiOptions).catch((error) => {
			const message =
				error instanceof ConfigError
					? `Notification plugin config error: ${error.message}`
					: `Notification plugin failed to load: ${error instanceof Error ? error.message : String(error)}`;
			logger.error(message);
			context.ui?.toast?.show?.({ message, variant: "error" });
			throw error;
		});

		const resolvedConfig = createResolvedConfig(config);
		const scheduler = createNotificationScheduler(resolvedConfig);

		const fetchSession = async (sessionId: string): Promise<SessionInfo | null> => {
			const cached = context.data?.session?.get?.(sessionId);
			if (cached) return cached;
			const fetched = await context.client?.session
				?.get?.({ sessionID: sessionId as SessionID })
				.catch(() => null);
			return fetched ?? null;
		};

		const resolveRootSessionId = async (
			sessionId: string,
			session: SessionInfo | null,
		): Promise<string> => {
			const cachedRoot = context.data?.session?.root?.(sessionId);
			if (cachedRoot && cachedRoot !== sessionId) return cachedRoot;
			if (!session?.parentID) return sessionId;

			let currentId = session.parentID;
			const seen = new Set<string>([sessionId]);
			for (let depth = 0; depth < 8 && currentId && !seen.has(currentId); depth++) {
				seen.add(currentId);
				const mapped = context.data?.session?.root?.(currentId);
				if (mapped && mapped !== currentId) return mapped;
				const parent = await fetchSession(currentId);
				if (!parent?.parentID) return currentId;
				currentId = parent.parentID;
			}
			return currentId;
		};

		const getSessionDetails = async (
			sessionId: string,
			fallbackDirectory?: string,
		): Promise<SessionDetails> => {
			if (sessionId === "global") {
				return {
					title: sessionId,
					directory: fallbackDirectory ?? getActiveDirectory(),
				};
			}

			const session = await fetchSession(sessionId);
			const rootSessionID = await resolveRootSessionId(sessionId, session);
			const rootSession = rootSessionID !== sessionId ? await fetchSession(rootSessionID) : session;

			return {
				title: session?.title ?? rootSession?.title ?? sessionId,
				directory:
					session?.location?.directory ??
					rootSession?.location?.directory ??
					fallbackDirectory ??
					getActiveDirectory(),
				parentID: session?.parentID,
				rootSessionID,
			};
		};

		const shouldHandleSession = (sessionId: string, details: SessionDetails): boolean => {
			if (sessionId === "global") {
				const route = context.ui?.router?.current?.();
				if (!route || route.type === "session") return true;
				return details.directory === getActiveDirectory();
			}

			const rootId =
				details.rootSessionID ??
				context.data?.session?.root?.(sessionId) ??
				details.parentID ??
				sessionId;

			const route = context.ui?.router?.current?.();
			if (route?.type === "session" && route.sessionID) {
				const currentRootId = context.data?.session?.root?.(route.sessionID) ?? route.sessionID;
				if (rootId === currentRootId || sessionId === route.sessionID) {
					return true;
				}
			}

			if (context.ui?.tabs?.enabled?.()) {
				const openTabs = context.ui.tabs.list?.() ?? [];
				if (openTabs.some((tab) => tab.sessionID === rootId || tab.sessionID === sessionId)) {
					return true;
				}
				if (openTabs.length > 0 || route?.type === "session") {
					return false;
				}
			} else if (route?.type === "session") {
				// When tabs are disabled (e.g. inside Herdr where each terminal pane owns
				// one session), ignore events from sessions running in other panes.
				return false;
			}

			if (!route) return true;
			return details.directory === getActiveDirectory();
		};

		const handler = createNotificationEventHandler({
			scheduler,
			getSessionDetails,
			shouldHandleSession,
		});

		const stopListen = context.data.listen(({ details }) => {
			void handler.handleEvent(details);
		});

		return () => {
			stopListen();
			handler.dispose();
		};
	},
});

export default SimpleNotificationTuiPlugin;
