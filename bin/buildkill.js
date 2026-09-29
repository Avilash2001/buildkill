#!/usr/bin/env node
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
