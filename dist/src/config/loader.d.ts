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
export declare function loadConfig(projectRoot: string, inlineOptions?: Record<string, unknown>): Promise<Config>;
//# sourceMappingURL=loader.d.ts.map