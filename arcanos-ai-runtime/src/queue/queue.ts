import { Queue } from "bullmq";
import { config, QUEUE_NAME } from "../config.js";

export const aiQueue = new Queue(QUEUE_NAME, {
  connection: {
    host: config.redisHost,
    port: config.redisPort,
  },
});
