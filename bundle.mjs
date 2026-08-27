import { build } from 'esbuild';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const entryPoint = path.join(__dirname, 'src/extension.ts');
const outFile = path.join(__dirname, 'out/extension.js');

async function runBuild() {
  try {
    await build({
      entryPoints: [entryPoint],
      bundle: true,
      minify: true,
      sourcemap: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      outfile: outFile,
      external: ['vscode'],
    });
    console.log('Bundling complete!');
  } catch (e) {
    console.error('Bundling failed:', e);
    process.exit(1);
  }
}

runBuild();
