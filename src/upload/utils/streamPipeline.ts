import { pipeline } from "stream";
import { promisify } from "util";

export const streamPipeline = promisify(pipeline);
