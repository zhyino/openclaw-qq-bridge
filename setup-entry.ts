import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { onebotPlugin } from "./src/channel.js";

const setupEntry: {
  id: string;
  name: string;
  description: string;
  configSchema: NonNullable<typeof onebotPlugin.configSchema>;
  register: (api: OpenClawPluginApi) => void;
  channelPlugin: typeof onebotPlugin;
} = defineChannelPluginEntry({
  id: "openclaw-qq-bridge",
  name: "OneBot",
  description: "OneBot 11 channel plugin (NapCat/go-cqhttp)",
  plugin: onebotPlugin,
});

export default setupEntry;
