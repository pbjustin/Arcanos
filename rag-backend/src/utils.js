export function chunkText(text, size) {
  const words = text.split(" ");
  const chunks = [];
  for (let i = 0; i < words.length; i += size) {
    chunks.push(words.slice(i, i + size).join(" "));
  }
  return chunks;
}
