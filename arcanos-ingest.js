// File: arcanos-ingest.js
// Usage: node arcanos-ingest.js <file-path> <namespace>

import fs from "fs";
import path from "path";
import { queryArcanos } from "./arcanos-interface.js";

// Helper: split text into manageable chunks (~2000 characters here, adjustable)
function splitIntoChunks(text, chunkSize = 2000) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

async function ingestFile(filePath, namespace) {
  try {
    const fileContents = fs.readFileSync(path.resolve(filePath), "utf8");
    const chunks = splitIntoChunks(fileContents);

    console.log(`📄 Ingesting file: ${filePath}`);
    console.log(`🔖 Namespace: ${namespace}`);
    console.log(`📦 Total chunks: ${chunks.length}`);

    for (let i = 0; i < chunks.length; i++) {
      const chunkTag = `${namespace}_chunk_${i + 1}`;
      try {
        const response = await queryArcanos(
          `Store the following content in namespace '${namespace}' under tag '${chunkTag}':\n${chunks[i]}`
        );
        console.log(`✅ Chunk ${i + 1}/${chunks.length} ingested:`, response);
      } catch (error) {
        console.error(`❌ Error ingesting chunk ${i + 1}:`, error.message);
      }
    }

    console.log("🎯 Ingestion complete.");
  } catch (err) {
    console.error("❌ Failed to read or process file:", err.message);
  }
}

// CLI usage
const [,, filePath, namespace] = process.argv;
if (!filePath || !namespace) {
  console.error("Usage: node arcanos-ingest.js <file-path> <namespace>");
  process.exit(1);
}

ingestFile(filePath, namespace);
