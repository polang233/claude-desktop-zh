import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = process.cwd();
const { spec, options } = JSON.parse(fs.readFileSync('plugins.json')).plugins[0];
const entry = file => pathToFileURL(path.join(spec, 'integrations/magpie', file));
const { ClaudeChinesePlugin } = await import(entry('server.mjs'));
const { closeWorkbenches } = await import(entry('workbench.mjs'));
const { tool } = await ClaudeChinesePlugin({ directory }, options);
process.on('message', async message => {
  if (message === 'close') await closeWorkbenches();
  process.exit(0);
});
process.on('disconnect', () => process.exit(0));
process.send(JSON.parse(await tool.claude_zh_workbench.execute({})));
