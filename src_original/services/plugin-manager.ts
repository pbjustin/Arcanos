export interface PluginRequest {
  message: string;
  args?: any;
}

export interface PluginResponse {
  success: boolean;
  data: any;
  error?: string;
}

export interface ArcanosPlugin {
  name: string;
  execute(request: PluginRequest): Promise<PluginResponse>;
}

class PluginManager {
  private plugins: Map<string, ArcanosPlugin> = new Map();

  register(plugin: ArcanosPlugin): void {
    this.plugins.set(plugin.name, plugin);
  }

  getPlugin(name: string): ArcanosPlugin | undefined {
    return this.plugins.get(name);
  }
}

export const pluginManager = new PluginManager();
