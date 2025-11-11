import OpenAI from "openai";
import { config } from "./env.js";

export const openai = new OpenAI({ apiKey: config.openaiKey });
