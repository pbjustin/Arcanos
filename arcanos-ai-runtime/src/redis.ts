import Redis from "ioredis";
import { config } from "./config.js";

export const redis = new Redis({
  host: config.redisHost,
  port: config.redisPort,
});
