#!/usr/bin/env node
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  process.stderr.write(`buildkill needs Node 18 or newer (this is ${process.version}).\n`);
  process.exit(1);
}
// More libuv threads = faster stat() storms. Must be set before the first async fs call.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16';

const { main } = await import('../src/cli.js');

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    process.stderr.write(`buildkill: ${err?.message ?? err}\n`);
    process.exit(1);
  },
);
