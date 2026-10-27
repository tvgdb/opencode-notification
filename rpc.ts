import { Rpc } from "@opencode/plugin/rpc";

/**
 * RPC contract between the server plugin and TUI plugin.
 *
 * OpenCode V2's `plugin.list` API reports active server plugins with `features.tui = true`
 * so the TUI auto-loads `./tui`, but omits inline `options` configured in `opencode.json(c)`.
 * Exposing `getOptions` over RPC lets the TUI plugin retrieve those server-side options
 * and lets the server plugin know a TUI client is handling notifications locally.
 */
export const NotificationRpc = Rpc.define({
	id: "opencode-notification",
	methods: {
		getOptions: {
			input: {
				type: "object",
				additionalProperties: false,
			},
			output: {
				type: "object",
				properties: {
					options: {
						type: "object",
					},
				},
				required: ["options"],
				additionalProperties: false,
			},
		},
	},
	events: {},
});

export default NotificationRpc;
