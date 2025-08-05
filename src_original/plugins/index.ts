import reversePlugin from './reverse-plugin.js';
import { pluginManager } from '../services/plugin-manager.js';

let loaded = false;

export function loadPlugins() {
  if (loaded) return;
  pluginManager.register(reversePlugin);
  loaded = true;
}
