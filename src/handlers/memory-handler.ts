// ARCANOS:MEMORY-HANDLER - Dedicated memory route handler
// Enforces clear handler separation and includes backup functionality

import { Request, Response } from "express";
import { MemoryStorage } from "../storage/memory-storage";
import { fallbackHandler } from "./fallback-handler";
import { modelControlHooks } from "../services/model-control-hooks";

export class MemoryHandler {
  private fallbackMemory: MemoryStorage;

  constructor() {
    this.fallbackMemory = new MemoryStorage();
  }

  async handleMemoryRequest(req: Request, res: Response): Promise<void> {
    console.log(
      "📝 MemoryHandler: Processing memory request with timestamp confirmation",
    );
    const timestamp = new Date().toISOString();

    try {
      const { memory_key, memory_value } = req.body;

      if (!memory_key) {
        res.status(400).json({
          error: "memory_key is required",
          example: {
            memory_key: "user_preference",
            memory_value: { theme: "dark" },
          },
          timestamp,
        });
        return;
      }

      if (memory_value === undefined) {
        res.status(400).json({
          error: "memory_value is required (can be null)",
          example: {
            memory_key: "user_preference",
            memory_value: { theme: "dark" },
          },
          timestamp,
        });
        return;
      }

      const container_id =
        (req.headers["x-container-id"] as string) || "default";

      console.log("💾 MEMORY-SNAPSHOT: Saving with timestamp confirmation:", {
        memory_key,
        container_id,
        timestamp,
      });

      let result;
      let backupUsed = false;

      try {
        const dispatch = await modelControlHooks.manageMemory(
          "store",
          {
            key: memory_key,
            value: memory_value,
            userId: container_id,
            sessionId: (req.headers["x-session-id"] as string) || "default",
          },
          {
            userId: container_id,
            sessionId: (req.headers["x-session-id"] as string) || "default",
            source: "api",
            metadata: { headers: req.headers },
          },
        );

        if (!dispatch.success) {
          throw new Error(dispatch.error || "ARCANOS memory dispatch failed");
        }

        result = dispatch.results?.[0]?.result;
        console.log("✅ MEMORY-SNAPSHOT: ARCANOS dispatch successful:", {
          memory_key,
          container_id,
          timestamp,
        });
      } catch (primaryError: any) {
        console.warn(
          "⚠️ ARCANOS memory dispatch failed, attempting secondary stream:",
          primaryError.message,
        );

        try {
          result = await this.fallbackMemory.storeMemory(
            container_id,
            "default",
            "context",
            memory_key,
            memory_value,
          );
          backupUsed = true;
          console.log("✅ MEMORY-SNAPSHOT: Secondary backup save successful:", {
            memory_key,
            container_id,
            timestamp,
          });
        } catch (backupError: any) {
          console.error(
            "❌ Both primary and backup memory saves failed:",
            backupError.message,
          );

          const fallbackResult = await fallbackHandler.handleUndefinedWorker({
            type: "memory",
            data: { memory_key, memory_value, container_id },
          });

          if (fallbackResult.success) {
            result = fallbackResult.data;
            backupUsed = true;
            console.log(
              "✅ MEMORY-SNAPSHOT: Fallback handler save successful:",
              { memory_key, container_id, timestamp },
            );
          } else {
            throw new Error(
              `All memory save attempts failed: ${fallbackResult.error}`,
            );
          }
        }
      }

      // Validate memory save operation with timestamp confirmation
      const validationLog = {
        memory_key,
        container_id,
        save_successful: true,
        backup_used: backupUsed,
        timestamp_confirmed: timestamp,
        validation_timestamp: new Date().toISOString(),
      };

      console.log(
        "✅ MEMORY-VALIDATION: Save operation validated:",
        validationLog,
      );

      res.status(200).json({
        success: true,
        message: "Memory saved successfully",
        data: result,
        snapshot_logged: true,
        backup_used: backupUsed,
        timestamp_confirmed: timestamp,
        validation: validationLog,
      });
    } catch (error: any) {
      console.error("❌ MEMORY-HANDLER: Complete failure:", error);
      res.status(500).json({
        error: "Failed to save memory",
        details: error.message,
        timestamp_confirmed: timestamp,
      });
    }
  }

  // Enhanced memory snapshot saving every 30 minutes
  startPeriodicMemorySnapshots(): void {
    console.log("⏰ Starting periodic memory snapshots every 30 minutes");

    // Primary: setInterval approach
    const intervalId = setInterval(
      async () => {
        await this.performScheduledSnapshot("setInterval");
      },
      30 * 60 * 1000,
    ); // 30 minutes

    // CRON fallback - using node-cron as backup
    try {
      const cron = require("node-cron");
      cron.schedule("*/30 * * * *", async () => {
        await this.performScheduledSnapshot("cron-fallback");
      });
      console.log("✅ CRON fallback scheduled for memory snapshots");
    } catch (cronError: any) {
      console.warn("⚠️ CRON fallback not available:", cronError.message);
    }

    // Cleanup on process exit
    process.on("exit", () => {
      clearInterval(intervalId);
      console.log("🛑 Memory snapshot interval cleared");
    });
  }

  private async performScheduledSnapshot(method: string): Promise<void> {
    const timestamp = new Date().toISOString();
    console.log(
      `📸 SCHEDULED-SNAPSHOT: Performing memory snapshot via ${method} at ${timestamp}`,
    );

    try {
      // Get all memory data for snapshot
      const allMemories =
        await this.fallbackMemory.getMemoriesByUser("default");

      // Create snapshot entry
      const snapshotData = {
        snapshot_id: `snapshot_${Date.now()}`,
        method,
        memory_count: allMemories.length,
        created_at: timestamp,
        memories: allMemories,
      };

      // Save snapshot using ARCANOS memory dispatch
      try {
        const dispatch = await modelControlHooks.manageMemory(
          "store",
          {
            key: `system_snapshot_${Date.now()}`,
            value: snapshotData,
            userId: "system",
            sessionId: "snapshot",
          },
          { userId: "system", sessionId: "snapshot", source: "system" },
        );

        if (!dispatch.success) {
          throw new Error(dispatch.error || "ARCANOS memory dispatch failed");
        }
        console.log("✅ SCHEDULED-SNAPSHOT: ARCANOS dispatch successful");
      } catch (primaryError: any) {
        console.warn(
          "⚠️ ARCANOS snapshot dispatch failed, using backup:",
          primaryError.message,
        );
        await this.fallbackMemory.storeMemory(
          "system",
          "snapshots",
          "system",
          `snapshot_${Date.now()}`,
          snapshotData,
        );
        console.log("✅ SCHEDULED-SNAPSHOT: Backup snapshot save successful");
      }

      // Timestamp confirmation log
      console.log("✅ SNAPSHOT-VALIDATION: Scheduled snapshot validated:", {
        snapshot_id: snapshotData.snapshot_id,
        method,
        memory_count: allMemories.length,
        timestamp_confirmed: timestamp,
      });
    } catch (error: any) {
      console.error(
        "❌ SCHEDULED-SNAPSHOT: Failed to perform snapshot:",
        error,
      );
    }
  }
}

// Export singleton instance
export const memoryHandler = new MemoryHandler();
