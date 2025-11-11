import { config } from "./config/env.js";
import app from "./app.js";

app.listen(config.port, () => {
  console.log(`ARCANOS Memory Service running on port ${config.port}`);
});
