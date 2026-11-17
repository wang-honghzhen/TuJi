import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tests=['context-version','context-summary','context-summary-facts','context-summary-upgrade','context-compaction','context-compaction-budget'];
const configPath=path.join(root,'tsconfig.json'),config=ts.readConfigFile(configPath,ts.sys.readFile);
if(config.error)throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText,'\n'));
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,root);
const program=ts.createProgram([...parsed.fileNames,...tests.map(name=>path.join(root,'scripts',`${name}.test.ts`))],parsed.options);
const diagnostics=[...parsed.errors,...ts.getPreEmitDiagnostics(program)];
if(diagnostics.length){
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:f=>f,getCurrentDirectory:()=>root,getNewLine:()=>'\n'}));
  process.exit(1);
}
const cache=path.join(root,'.cache');mkdirSync(cache,{recursive:true});
const out=mkdtempSync(path.join(cache,'context-tests-'));
try {
  for(const name of tests)await build({absWorkingDir:root,entryPoints:[`scripts/${name}.test.ts`],outfile:path.join(out,`${name}.cjs`),
    bundle:true,platform:'node',format:'cjs',target:'node24',alias:{'@':path.join(root,'src')},
    external:['electron','pdfjs-dist','pdfjs-dist/*','@napi-rs/canvas','tesseract.js']});
  const result=spawnSync(process.execPath,['--test',...tests.map(name=>path.join(out,`${name}.cjs`))],{stdio:'inherit'});
  if(result.error)throw result.error;
  process.exitCode=result.status??1;
} finally {
  // Only the unique directory created by this invocation is removed.
  rmSync(out,{recursive:true,force:true});
}
