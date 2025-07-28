import { Router } from "express";
import { loadPlugins } from "../plugins";
import { pluginManager } from "../services/plugin-manager";
import { MemoryStorage } from "../storage/memory-storage";

const router = Router();
let pluginsLoaded = false;
const memoryStorage = new MemoryStorage();

function ensurePluginsLoaded() {
  if (!pluginsLoaded) {
    loadPlugins();
    pluginsLoaded = true;
  }
}

router.post("/:name", async (req, res) => {
  ensurePluginsLoaded();
  const pluginName = req.params.name;
  const { message = "", args } = req.body;

  const plugin = pluginManager.getPlugin(pluginName);
  if (!plugin) {
    return res
      .status(404)
      .json({ error: "Plugin not found", plugin: pluginName });
  }

  try {
    const result = await plugin.execute({ message, args });
    // Store plugin interaction in memory for bridging
    await memoryStorage.storeMemory(
      "user",
      "plugin-session",
      "interaction",
      `${pluginName}_${Date.now()}`,
      { request: { message, args }, response: result.data },
      [pluginName, "plugin"],
    );

    res.json(result);
  } catch (error: any) {
    res
      .status(500)
      .json({
        success: false,
        error: error.message || "Plugin execution failed",
      });
  }
});

export default router;
