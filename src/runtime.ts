import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const runtimeStore = createPluginRuntimeStore<PluginRuntime>("OneBot runtime not initialized");

export const setOneBotRuntime = runtimeStore.setRuntime;
export const clearOneBotRuntime = runtimeStore.clearRuntime;
export const tryGetOneBotRuntime = runtimeStore.tryGetRuntime;
export const getOneBotRuntime = runtimeStore.getRuntime;
