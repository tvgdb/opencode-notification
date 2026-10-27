// @bun
// rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var NotificationRpc = Rpc.define({
  id: "opencode-notification",
  methods: {
    getOptions: {
      input: {
        type: "object",
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: {
          options: {
            type: "object"
          }
        },
        required: ["options"],
        additionalProperties: false
      }
    }
  },
  events: {}
});
var rpc_default = NotificationRpc;
export {
  NotificationRpc,
  rpc_default as default
};
