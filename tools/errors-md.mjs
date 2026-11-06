// Writes docs/errors.md from the catalog (src/errors.ts): node tools/errors-md.mjs
import fs from 'node:fs';
import { errorsMarkdown } from '../src/errors.ts';
fs.writeFileSync(new URL('../docs/errors.md', import.meta.url), errorsMarkdown());
console.log('docs/errors.md written');
