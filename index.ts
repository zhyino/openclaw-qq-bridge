import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk/core";
import { onebotPlugin } from "./src/channel.js";
import { setOneBotRuntime } from "./src/runtime.js";

const entry: {
  id: string;
  name: string;
  description: string;
  configSchema: NonNullable<typeof onebotPlugin.configSchema>;
  register: (api: OpenClawPluginApi) => void;
  channelPlugin: typeof onebotPlugin;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
} = defineChannelPluginEntry({
  id: "openclaw-qq-bridge",
  name: "QQ Bridge",
  description: "OneBot 11 channel plugin (NapCat/go-cqhttp)",
  plugin: onebotPlugin,
  setRuntime: setOneBotRuntime,
});

export default entry;
export { onebotPlugin } from "./src/channel.js";
export { setOneBotRuntime, clearOneBotRuntime, getOneBotRuntime, tryGetOneBotRuntime } from "./src/runtime.js";
export * from "./src/types.js";
export * from "./src/paths.js";
export * from "./src/policy.js";
export * from "./src/config.js";
export * from "./src/gateway.js";
export * from "./src/outbound.js";
