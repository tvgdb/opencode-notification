/**
 * RPC contract between the server plugin and TUI plugin.
 *
 * OpenCode V2's `plugin.list` API reports active server plugins with `features.tui = true`
 * so the TUI auto-loads `./tui`, but omits inline `options` configured in `opencode.json(c)`.
 * Exposing `getOptions` over RPC lets the TUI plugin retrieve those server-side options
 * and lets the server plugin know a TUI client is handling notifications locally.
 */
export declare const NotificationRpc: {
    readonly id: "opencode-notification";
    readonly methods: {
        readonly getOptions: {
            readonly input: {
                readonly type: "object";
                readonly additionalProperties: false;
            };
            readonly output: {
                readonly type: "object";
                readonly properties: {
                    readonly options: {
                        readonly type: "object";
                    };
                };
                readonly required: readonly ["options"];
                readonly additionalProperties: false;
            };
        };
    };
    readonly events: {};
};
export default NotificationRpc;
//# sourceMappingURL=rpc.d.ts.map