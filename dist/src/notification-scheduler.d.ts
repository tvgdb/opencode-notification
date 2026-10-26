import type { NotificationEventType, ResolvedConfig } from "@/config/resolver";
type Schedule = (sessionId: string, title: string, message: string, eventType: NotificationEventType) => void;
interface NotificationScheduler {
    schedule: Schedule;
    cancelForSession: (sessionId: string) => void;
    cancelAll: () => void;
}
export declare function createNotificationScheduler(resolvedConfig: ResolvedConfig): NotificationScheduler;
export {};
//# sourceMappingURL=notification-scheduler.d.ts.map