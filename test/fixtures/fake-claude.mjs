// Stands in for `claude`: prompt on stdin, answers like `claude -p --output-format json`.
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.0.0 (fake Claude Code)'); process.exit(0); }
let stdin = '';
for await (const c of process.stdin) stdin += c;
writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ args, cwd: process.cwd(), stdin, hasApiKey: 'ANTHROPIC_API_KEY' in process.env }));
if (/LIMIT/.test(stdin)) {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Claude usage limit reached. Your limit will reset at 5pm.' }));
  process.exit(1);
}
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"title":"Från claude"}', total_cost_usd: 0.01 }));
