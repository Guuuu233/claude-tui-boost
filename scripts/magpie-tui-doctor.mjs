#!/usr/bin/env node
import { inspectDeployment } from '../src/deployment-preflight.mjs';

const args = process.argv.slice(2);
if (args.includes('--help') || args.length === 0) {
  console.log('Usage: magpie-tui-doctor --plugins /path/to/plugins.json --runtime-dir /path/to/runtime-state [--service-uid NUM]');
  console.log('Read-only local configuration check: does not connect, launch, read OAuth credentials or alter services.');
  process.exit(args.includes('--help') ? 0 : 2);
}
const flags = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--plugins', '--runtime-dir', '--service-uid'].includes(args[i]) || i + 1 >= args.length) {
    console.error('Unknown or incomplete argument; use --help');
    process.exit(2);
  }
  flags[args[i]] = args[i + 1];
}
const result = inspectDeployment({
  pluginsPath: flags['--plugins'], runtimeDir: flags['--runtime-dir'],
  ...(flags['--service-uid'] === undefined ? {} : { serviceUid: Number(flags['--service-uid']) }),
});
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 2);
