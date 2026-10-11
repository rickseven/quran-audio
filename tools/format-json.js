#!/usr/bin/env node
// Read JSON from stdin, write it to stdout with 2-space indent (used by generate-json.ps1).
let input = '';
process.stdin
  .on('data', (chunk) => (input += chunk))
  .on('end', () => process.stdout.write(JSON.stringify(JSON.parse(input), null, 2) + '\n'));
