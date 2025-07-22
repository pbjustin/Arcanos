import { ArcanosPlugin, PluginRequest, PluginResponse } from '../services/plugin-manager';

const reversePlugin: ArcanosPlugin = {
  name: 'reverse',
  async execute(request: PluginRequest): Promise<PluginResponse> {
    const reversed = (request.message || '').split('').reverse().join('');
    return { success: true, data: { reversed } };
  }
};

export default reversePlugin;
