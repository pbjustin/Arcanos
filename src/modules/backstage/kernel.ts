import { Kernel, ModuleStatus, ActivationOptions } from './bootloader.js';

// Simple in-memory kernel implementation used for bootstrapping.
// In real deployments this should interface with the actual system kernel.
const moduleState: Record<string, ModuleStatus> = {
  backstage_booker: 'BOOT_FAILED'
};

const kernel: Kernel = {
  async checkModuleStatus(moduleId: string): Promise<ModuleStatus> {
    return moduleState[moduleId] ?? 'INACTIVE';
  },
  async activateModule(
    moduleId: string,
    _options: ActivationOptions = {}
  ): Promise<{ success: boolean }> {
    moduleState[moduleId] = 'ACTIVE';
    return { success: true };
  }
};

export default kernel;

