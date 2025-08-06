if (typeof global.gc !== 'function') {
  console.error('GC is not exposed. Start node with --expose-gc.');
  process.exit(1);
}

console.log('GC is exposed. Forcing garbage collection...');
const before = process.memoryUsage().heapUsed;
global.gc();
const after = process.memoryUsage().heapUsed;

console.log(`Memory before GC: ${before}`);
console.log(`Memory after GC:  ${after}`);
console.log(`Recovered: ${(before - after) / 1024} KB`);
