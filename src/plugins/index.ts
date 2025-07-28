import reversePlugin from "./reverse-plugin";
import { pluginManager } from "../services/plugin-manager";

let loaded = false;

export function loadPlugins() {
  if (loaded) return;
  pluginManager.register(reversePlugin);
  loaded = true;
}
