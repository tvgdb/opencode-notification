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
}
export interface NotificationEventHandler {
    handleEvent: (event: OpenCodeEvent) => Promise<void>;
    onPrompt: (sessionId: string) => void;
    dispose: () => void;
}
export declare function createNotificationEventHandler({ scheduler, getSessionDetails, shouldHandleSession, isSuppressed, }: NotificationEventHandlerOptions): NotificationEventHandler;
//# sourceMappingURL=event-handler.d.ts.map