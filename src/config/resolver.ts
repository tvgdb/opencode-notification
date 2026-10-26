import type { OpenCodeEvent } from "@opencode/client";
import type { Config, EventConfig } from "@/config/schema";

export type NotificationEventType =
	| OpenCodeEvent["type"]
	| "session.error"
	| "question.asked"
	| "question.replied";

const EVENT_CONFIG_MAP: Record<string, keyof Config | undefined> = {
	"session.idle": "response_ready",
	"session.execution.succeeded": "response_ready",
	"session.error": "error",
	"session.execution.failed": "error",
	"session.compaction.failed": "error",
	"permission.asked": "permission_asked",
	"question.asked": "question_asked",
	"form.created": "question_asked",
};

export interface ResolvedConfig {
	readonly globalEnabled: boolean;
	isEnabled(eventType: NotificationEventType): boolean;
	getDelay(eventType: NotificationEventType): number;
}

export function createResolvedConfig(config: Config): ResolvedConfig {
	const globalEnabled = config.enabled;

	return {
		get globalEnabled() {
			return globalEnabled;
		},

		isEnabled(eventType: NotificationEventType): boolean {
			const configKey = EVENT_CONFIG_MAP[eventType];
			// TS infers config[keyof Config] as union; cast safe since Zod validates + configKey from EVENT_CONFIG_MAP
			const eventConfig: EventConfig | undefined = configKey
				? (config[configKey] as EventConfig)
				: undefined;

			if (eventConfig?.enabled !== undefined) {
				return eventConfig.enabled;
			}

			return globalEnabled;
		},

		getDelay(eventType: NotificationEventType): number {
			const configKey = EVENT_CONFIG_MAP[eventType];
			// TS infers config[keyof Config] as union; cast safe since Zod validates + configKey from EVENT_CONFIG_MAP
			const eventConfig: EventConfig | undefined = configKey
				? (config[configKey] as EventConfig)
				: undefined;
			const delayMS = eventConfig?.delay ?? config.delay;

			return delayMS * 1000;
		},
	};
}
