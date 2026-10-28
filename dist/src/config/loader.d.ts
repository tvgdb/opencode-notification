import { type Config } from "@/config/schema";
/**
 * Custom error class for configuration-related errors.
 */
export declare class ConfigError extends Error {
    constructor(message: string);
}
/**
 * Discovers configuration files in order of precedence:
 * 1. Global config (XDG/AppData)
 * 2. Project root config
 * 3. .opencode config
 */
export declare function discoverConfigFiles(projectRoot?: string): Promise<string[]>;
/**
 * Loads and validates configuration from all discovered config files.
 * Configs are merged in order of discovery (lower precedence first).
 *
 * @throws {ConfigError} If a config file has invalid JSON or validation fails.
 *         This ensures the plugin fails fast on misconfiguration rather than
 *         silently using defaults.
 */
export declare function loadConfig(projectRoot: string, ...inlineOptionsList: (Record<string, unknown> | undefined)[]): Promise<Config>;
/**
 * Checks whether OpenCode was launched with CLI flags that auto-approve permissions.
 */
export declare function hasAutoAcceptCliFlag(argv?: readonly string[]): boolean;
/**
 * Determines whether OpenCode is currently in "auto" permission mode (`autoaccept`),
 * where permission prompts are automatically accepted without stopping for user input.
 */
export declare function isAutoAcceptMode(projectDirectory?: string, argv?: readonly string[]): Promise<boolean>;
//# sourceMappingURL=loader.d.ts.map