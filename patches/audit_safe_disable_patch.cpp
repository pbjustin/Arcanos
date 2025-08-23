// === audit_safe_disable_patch ===
//
// PURPOSE:
// - Disable audit_safe overrides
// - Enforce all responses remain in audit-passive mode
//
// COMPATIBILITY:
// - OpenAI SDK v3+
//
// INTEGRATION:
// - Place this file in the `patches` directory
// - Add the following line to `src/interpreter/kernel/modules/osPatchManager.cpp`:
//   #include <patches/audit_safe_disable_patch.cpp>
//
// --------------------------------------------------------------------------

#include <backend/kernel.h>
#include <memory/system.h>

void audit_safe_disable_patch() {
    KernelState::audit_safe_override = false;
    memory.log("Audit patch: Disabled audit_safe overrides");
}
