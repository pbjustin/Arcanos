import process from 'node:process';

const [mode] = process.argv.slice(2);

switch (mode) {
  case 'valid':
    process.stdout.write('{"schemaVersion":1}\n');
    break;
  case 'stdout-over':
    process.stdout.write(Buffer.alloc(2049, 0x41));
    break;
  case 'stderr-over':
    process.stderr.write(Buffer.alloc(257, 0x42));
    break;
  case 'invalid-utf8':
    process.stdout.write(Buffer.from([0xc3, 0x28]));
    break;
  case 'timeout':
    setInterval(() => {}, 60_000);
    break;
  default:
    process.exitCode = 64;
}
