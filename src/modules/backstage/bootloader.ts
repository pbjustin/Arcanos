/**
 * Fallback bootloader activation for Backstage Booker module.
 * Ensures module is reactivated safely if it enters a BOOT_FAILED state.
 */

export type ModuleStatus = 'ACTIVE' | 'INACTIVE' | 'BOOT_FAILED';

export interface ActivationOptions {
  force?: boolean;
  bypassIsolation?: boolean;
  safeMode?: boolean;
}

export interface Kernel {
  checkModuleStatus(moduleId: string): Promise<ModuleStatus>;
  activateModule(
    moduleId: string,
    options?: ActivationOptions
  ): Promise<{ success: boolean }>;
}

export interface Audit {
  log: (message?: any, ...optionalParams: any[]) => void;
  warn: (message?: any, ...optionalParams: any[]) => void;
  error: (message?: any, ...optionalParams: any[]) => void;
}

/**
 * Attempts to activate the Backstage Booker module if it failed to boot.
 *
 * @param kernel Kernel interface used to query and activate modules.
 * @param audit Logging interface for audit purposes (defaults to console).
 * @param moduleId Module identifier, defaults to `backstage_booker`.
 * @returns Whether the module ended up active.
 */
export async function activateBackstageBooker(
  kernel: Kernel,
  audit: Audit = console,
  moduleId = 'backstage_booker'
): Promise<boolean> {
  try {
    const status = await kernel.checkModuleStatus(moduleId);

    if (status === 'BOOT_FAILED') {
      audit.log(
        `[ARCANOS] Detected ${moduleId} in BOOT_FAILED. Attempting safe reactivation...`
      );

      const result = await kernel.activateModule(moduleId, {
        force: true,
        bypassIsolation: true,
        safeMode: true
      });

      if (result.success) {
        audit.log(`[ARCANOS] ✅ ${moduleId} reactivated successfully.`);
        return true;
      }

      audit.warn(
        `[ARCANOS] ⚠️ Fallback activation failed. Manual inspection required.`
      );
      return false;
    }

    audit.log(`[ARCANOS] ${moduleId} already in ${status} state.`);
    return status === 'ACTIVE';
  } catch (err) {
    audit.error(`[ARCANOS] ❌ Activation exception:`, err);
    return false;
  }
}

