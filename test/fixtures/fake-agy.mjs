// Stands in for `agy`: records how it was called, answers like `agy -p … --output-format json`.
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('agy 0.0.0-fake'); process.exit(0); }
const prompt = args[args.indexOf('-p') + 1];
const file = join(process.cwd(), 'prompt.md');
writeFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ args, cwd: process.cwd(), promptFile: existsSync(file) ? readFileSync(file, 'utf8') : null }));
const model = args[args.indexOf('--model') + 1];
if (/^nope/.test(model)) {
  console.error(`Error: unknown model "${model}"`);
  process.exit(1);
}
if (/QUOTA/.test(prompt)) {
  console.log(JSON.stringify({ status: 'ERROR', response: '', error: 'RESOURCE_EXHAUSTED', finished_reason: 'rate_limited' }));
  console.error('AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","retryable":true,"reason":"rate_limit"}');
  process.exit(3);
}
console.log(JSON.stringify({ conversation_id: 'c1', status: 'SUCCESS', response: 'Here it is:\n```json\n{"title":"Från agy"}\n```\n', num_turns: 1 }));
