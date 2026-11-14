import { build } from 'esbuild';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.cwd(),cache=path.resolve(root,'.cache');
await mkdir(cache,{recursive:true});
const directory=await mkdtemp(path.join(cache,'graph-search-'));
try {
  const outfile=path.join(directory,'tests.cjs');
  await build({entryPoints:['scripts/graph-search.test.ts'],outfile,bundle:true,platform:'node',format:'cjs',target:'node24',alias:{'@':path.join(root,'src')}});
  (await import(pathToFileURL(outfile).href)).runGraphSearchTests();
} finally {
  const relative=path.relative(cache,directory);
  if(relative.startsWith('graph-search-')&&!relative.includes('..')&&!path.isAbsolute(relative)) await rm(directory,{recursive:true,force:true});
}
