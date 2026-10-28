import path from "node:path";
import type { OpenCodeEvent } from "@opencode/client";
import type { NotificationScheduler } from "@/notification-scheduler";

export interface SessionDetails {
	title: string;
	directory: string;
	parentID?: string;
	rootSessionID?: string;
}

export interface NotificationEventHandlerOptions {
	scheduler: NotificationScheduler;
	getSessionDetails: (sessionId: string, fallbackDirectory?: string) => Promise<SessionDetails>;
	/**
	 * Optional filter used by TUI instances to scope notifications to sessions
	 * owned by the current terminal pane or open tabs.
	 */
	shouldHandleSession?: (sessionId: string, details: SessionDetails) => boolean;
	/**
	 * When true, suppresses scheduling new notifications (used on the server
	 * once a TUI plugin instance has connected and taken over notification delivery).
	 */
	isSuppressed?: () => boolean;
	/**
	 * When true, suppresses `permission.asked` notifications because OpenCode
	 * is in "auto" mode and auto-accepts permission requests without stopping.
	 */
	isAutoAccept?: (directory?: string) => Promise<boolean> | boolean;
}

export interface NotificationEventHandler {
	handleEvent: (event: OpenCodeEvent) => Promise<void>;
	onPrompt: (sessionId: string) => void;
	dispose: () => void;
}

function isDeniedReply(response: unknown): boolean {
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
}

function isAbortedError(error?: { type?: string; name?: string; message?: string }): boolean {
	if (!error) return false;
	const kind = (error.type ?? error.name ?? "").toLowerCase();
	return (
		error.type === "MessageAbortedError" ||
		error.name === "MessageAbortedError" ||
		kind.includes("abort") ||
		kind.includes("interrupt")
	);
}

export function createNotificationEventHandler({
	scheduler,
	getSessionDetails,
	shouldHandleSession,
	isSuppressed,
	isAutoAccept,
}: NotificationEventHandlerOptions): NotificationEventHandler {
	// Tracks sessions where assistant execution has started since the last completion/interruption.
	const activeSessions = new Set<string>();
	// Tracks sessions explicitly interrupted or aborted by the user to suppress trailing idle events.
	const interruptedSessions = new Set<string>();
	// Maps subagent child session IDs to their root session ID so interrupting or
	// prompting the root session also cancels pending subagent permission/form timers.
	const childToRoot = new Map<string, string>();
	let eventQueue = Promise.resolve();
	let disposed = false;

	const recordHierarchy = (
		sessionId: string,
		details: Pick<SessionDetails, "parentID" | "rootSessionID">,
	) => {
		const rootId = details.rootSessionID ?? details.parentID;
		if (rootId && rootId !== sessionId) {
			childToRoot.set(sessionId, childToRoot.get(rootId) ?? rootId);
		}
	};

	const cancelOnlyTimers = (sessionId: string) => {
		scheduler.cancelForSession(sessionId);
		for (const [childId, rootId] of childToRoot) {
			if (rootId === sessionId) {
				scheduler.cancelForSession(childId);
			}
		}
	};

	const cancelForSession = (sessionId: string) => {
		cancelOnlyTimers(sessionId);
		activeSessions.delete(sessionId);
	};

	const markSessionInterrupted = (sessionId: string) => {
		interruptedSessions.add(sessionId);
		cancelForSession(sessionId);
		for (const [childId, rootId] of childToRoot) {
			if (rootId === sessionId) {
				interruptedSessions.add(childId);
				activeSessions.delete(childId);
			}
		}
	};

	const onPrompt = (sessionId: string) => {
		interruptedSessions.delete(sessionId);
		cancelForSession(sessionId);
	};

	const processEvent = async (event: OpenCodeEvent): Promise<void> => {
		switch (event.type) {
			case "session.created":
			case "session.forked": {
				if (event.data.parentID) {
					const rootId = childToRoot.get(event.data.parentID) ?? event.data.parentID;
					childToRoot.set(event.data.sessionID, rootId);
				}
				return;
			}

			case "session.deleted": {
				const sessionId = event.data.sessionID;
				cancelForSession(sessionId);
				interruptedSessions.delete(sessionId);
				childToRoot.delete(sessionId);
				return;
			}

			case "session.execution.started":
			case "session.step.started": {
				const sessionId = event.data.sessionID;
				interruptedSessions.delete(sessionId);
				cancelOnlyTimers(sessionId);
				activeSessions.add(sessionId);
				return;
			}

			case "session.inbox.enqueued": {
				const sessionId = event.data.sessionID;
				if (event.data.item.type === "user") {
					onPrompt(sessionId);
				}
				return;
			}

			case "session.inbox.delivered": {
				const sessionId = event.data.sessionID;
				interruptedSessions.delete(sessionId);
				cancelOnlyTimers(sessionId);
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
				if (isSuppressed?.()) return;

				const details = await getSessionDetails(sessionId, event.location?.directory);
				recordHierarchy(sessionId, details);

				// Subagent completions return control to the parent session, which is still
				// running; only notify "Response ready" when a root session completes.
				if (details.parentID) return;
				if (shouldHandleSession && !shouldHandleSession(sessionId, details)) return;

				scheduler.schedule(sessionId, "Response ready", details.title, event.type);
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
				if (isSuppressed?.()) return;

				const details = await getSessionDetails(sessionId, event.location?.directory);
				recordHierarchy(sessionId, details);
				if (shouldHandleSession && !shouldHandleSession(sessionId, details)) return;

				scheduler.schedule(sessionId, "Session error", details.title, event.type);
				return;
			}

			case "session.execution.interrupted": {
				markSessionInterrupted(event.data.sessionID);
				return;
			}

			case "permission.asked": {
				if (isSuppressed?.()) return;
				const sessionId = event.data.sessionID;
				const details = await getSessionDetails(sessionId, event.location?.directory);
				recordHierarchy(sessionId, details);
				if (shouldHandleSession && !shouldHandleSession(sessionId, details)) return;
				if (await isAutoAccept?.(details.directory)) return;

				const projectName = path.basename(details.directory);
				scheduler.schedule(
					sessionId,
					"Permission Asked",
					`${details.title} in ${projectName} needs permission`,
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
				if (isSuppressed?.()) return;
				const sessionId = event.data.form.sessionID;
				const details = await getSessionDetails(sessionId, event.location?.directory);
				recordHierarchy(sessionId, details);
				if (shouldHandleSession && !shouldHandleSession(sessionId, details)) return;

				const projectName = path.basename(details.directory);
				scheduler.schedule(
					sessionId,
					"Question",
					`${details.title} in ${projectName} has a question`,
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
					cancelOnlyTimers(event.data.sessionID);
				}
				return;
			}

			case "tui.prompt.append":
			case "tui.command.execute":
				return;
		}
	};

	const handleEvent = (event: OpenCodeEvent): Promise<void> => {
		const next = eventQueue.then(() => {
			if (disposed) return;
			return processEvent(event);
		});
		eventQueue = next.catch(() => {});
		return next;
	};

	const dispose = () => {
		disposed = true;
		scheduler.cancelAll();
		activeSessions.clear();
		interruptedSessions.clear();
		childToRoot.clear();
	};

	return {
		handleEvent,
		onPrompt,
		dispose,
	};
}
