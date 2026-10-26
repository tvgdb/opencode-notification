import type { OpenCodeEvent } from "@opencode/client";
import type { Config } from "@/config/schema";
export type NotificationEventType = OpenCodeEvent["type"] | "session.error" | "question.asked" | "question.replied";
export interface ResolvedConfig {
    readonly globalEnabled: boolean;
    isEnabled(eventType: NotificationEventType): boolean;
    getDelay(eventType: NotificationEventType): number;
}
export declare function createResolvedConfig(config: Config): ResolvedConfig;
//# sourceMappingURL=resolver.d.ts.map