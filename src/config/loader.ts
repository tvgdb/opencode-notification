import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ConfigSchema, type Config } from "@/config/schema";
import { CONFIG_FILE_NAME } from "@/config/constants";

/**
 * Custom error class for configuration-related errors.
 */
export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/**
 * Recursively merges objects. Arrays are replaced, not merged.
 * Null/undefined values in source do not overwrite existing values.
 */
function deepMerge(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): Record<string, unknown> {
	if (source === null || typeof source !== "object") return target;
	if (Array.isArray(source)) return source;

	const result: Record<string, unknown> = { ...target };

	for (const key in source) {
		const sourceValue = source[key];
		const targetValue = result[key];

		if (
			sourceValue !== null &&
			typeof sourceValue === "object" &&
			!Array.isArray(sourceValue) &&
			targetValue !== null &&
			typeof targetValue === "object" &&
			!Array.isArray(targetValue)
		) {
			// Recursively merge nested objects
			result[key] = deepMerge(
				targetValue as Record<string, unknown>,
				sourceValue as Record<string, unknown>,
			);
		} else if (sourceValue !== undefined) {
			result[key] = sourceValue;
		}
	}

	return result;
}

/**
 * Discovers configuration files in order of precedence:
 * 1. Global config (XDG/AppData)
 * 2. Project root config
 * 3. .opencode config
 */
export async function discoverConfigFiles(projectRoot?: string): Promise<string[]> {
	const paths: string[] = [];

	// 1. Global config
	const globalPath =
		process.platform === "win32"
			? // Convert forward slashes to backslashes for Windows paths (e.g., "a/b" -> "a\b")
				`${process.env.APPDATA || homedir()}\\${CONFIG_FILE_NAME}`.replace(/\//g, "\\") // windows
			: `${process.env.XDG_CONFIG_HOME || `${homedir()}/.config`}/${CONFIG_FILE_NAME}`; // linux/macos

	if (await Bun.file(globalPath).exists()) {
		paths.push(globalPath);
	}

	// 2. Project root config
	if (projectRoot) {
		const projectPath = `${projectRoot}/${CONFIG_FILE_NAME}`;
		if (await Bun.file(projectPath).exists()) {
			paths.push(projectPath);
		}

		// 3. .opencode config
		const dotOpenCodePath = `${projectRoot}/.opencode/${CONFIG_FILE_NAME}`;
		if (await Bun.file(dotOpenCodePath).exists()) {
			paths.push(dotOpenCodePath);
		}
	}

	return paths;
}

/**
 * Loads and validates configuration from all discovered config files.
 * Configs are merged in order of discovery (lower precedence first).
 *
 * @throws {ConfigError} If a config file has invalid JSON or validation fails.
 *         This ensures the plugin fails fast on misconfiguration rather than
 *         silently using defaults.
 */
export async function loadConfig(
	projectRoot: string,
	...inlineOptionsList: (Record<string, unknown> | undefined)[]
): Promise<Config> {
	const filePaths = await discoverConfigFiles(projectRoot);
	const configs: Record<string, unknown>[] = [];

	for (const filePath of filePaths) {
		try {
			const content = await Bun.file(filePath).json();
			if (content && typeof content === "object") {
				configs.push(content as Record<string, unknown>);
			}
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw new ConfigError(`Invalid JSON in ${filePath}: ${error.message}`);
			}
			throw new ConfigError(
				`Failed to read config file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	for (const inlineOptions of inlineOptionsList) {
		if (inlineOptions && typeof inlineOptions === "object" && !Array.isArray(inlineOptions)) {
			configs.push(inlineOptions);
		}
	}

	const mergedConfig = configs.reduce<Record<string, unknown>>(
		(acc, config) => deepMerge(acc, config),
		{},
	);

	try {
		return ConfigSchema.parse(mergedConfig);
	} catch (error) {
		// Zod validation errors - rethrow as ConfigError for consistent error handling
		const message = error instanceof Error ? error.message : String(error);
		throw new ConfigError(`Config validation failed: ${message}`);
	}
}

type SessionPermissionsMode = "autoaccept" | "prompt";

interface CachedCliConfigEntry {
	mtimeMs: number;
	size: number;
	permissions: SessionPermissionsMode | undefined;
}

const cliConfigCache = new Map<string, CachedCliConfigEntry>();

function parseJsonOrJsonc(text: string): unknown {
	const jsoncParser = (Bun as unknown as { JSONC?: { parse?: (input: string) => unknown } }).JSONC
		?.parse;
	if (typeof jsoncParser === "function") {
		return jsoncParser(text);
	}
	return JSON.parse(text);
}

function extractSessionPermissionsMode(value: unknown): SessionPermissionsMode | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const session = (value as Record<string, unknown>).session;
	if (!session || typeof session !== "object" || Array.isArray(session)) return undefined;
	const permissions = (session as Record<string, unknown>).permissions;
	if (permissions === "autoaccept" || permissions === "prompt") {
		return permissions;
	}
	return undefined;
}

/**
 * Checks whether OpenCode was launched with CLI flags that auto-approve permissions.
 */
export function hasAutoAcceptCliFlag(argv: readonly string[] = process.argv.slice(2)): boolean {
	for (const arg of argv) {
		if (arg === "--") break;
		if (
			arg === "--auto" ||
			arg === "--auto=true" ||
			arg === "--yolo" ||
			arg === "--yolo=true" ||
			arg === "--dangerously-skip-permissions" ||
			arg === "--dangerously-skip-permissions=true"
		) {
			return true;
		}
	}
	return false;
}

function getCandidateCliConfigPaths(projectDirectory?: string): string[] {
	const paths: string[] = [];

	if (projectDirectory) {
		paths.push(path.join(projectDirectory, ".opencode", "cli.json"));
		paths.push(path.join(projectDirectory, "cli.json"));
	}

	if (process.env.OPENCODE_CONFIG_DIR) {
		paths.push(path.join(process.env.OPENCODE_CONFIG_DIR, "cli.json"));
	}

	const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
	paths.push(path.join(xdgConfigHome, "opencode", "cli.json"));

	if (process.platform === "win32" && process.env.APPDATA) {
		paths.push(path.join(process.env.APPDATA, "opencode", "cli.json"));
	}

	return [...new Set(paths)];
}

async function readCliConfigPermissionsMode(
	filePath: string,
): Promise<SessionPermissionsMode | undefined> {
	try {
		const stats = await stat(filePath);
		const cached = cliConfigCache.get(filePath);
		if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
			return cached.permissions;
		}

		const text = await Bun.file(filePath).text();
		const parsed = parseJsonOrJsonc(text);
		const permissions = extractSessionPermissionsMode(parsed);
		cliConfigCache.set(filePath, {
			mtimeMs: stats.mtimeMs,
			size: stats.size,
			permissions,
		});
		return permissions;
	} catch {
		cliConfigCache.delete(filePath);
		return undefined;
	}
}

/**
 * Determines whether OpenCode is currently in "auto" permission mode (`autoaccept`),
 * where permission prompts are automatically accepted without stopping for user input.
 */
export async function isAutoAcceptMode(
	projectDirectory?: string,
	argv: readonly string[] = process.argv.slice(2),
): Promise<boolean> {
	if (hasAutoAcceptCliFlag(argv)) {
		return true;
	}

	const inlineCliConfig = process.env.OPENCODE_CLI_CONFIG_CONTENT?.trim();
	if (inlineCliConfig) {
		try {
			const parsed = parseJsonOrJsonc(inlineCliConfig);
			const inlineMode = extractSessionPermissionsMode(parsed);
			if (inlineMode !== undefined) {
				return inlineMode === "autoaccept";
			}
		} catch {
			// Ignore malformed inline config and fall back to cli.json files
		}
	}

	for (const candidatePath of getCandidateCliConfigPaths(projectDirectory)) {
		const mode = await readCliConfigPermissionsMode(candidatePath);
		if (mode !== undefined) {
			return mode === "autoaccept";
		}
	}

	return false;
}
