import { build } from 'vite';
import path from 'node:path';
await build({ configFile:false, root:path.resolve('desktop'), base:'./',
  resolve:{alias:{'@codemirror/lang-html':path.resolve('CoreEditor/src/@vendor/lang-html'),'@codemirror/lang-markdown':path.resolve('CoreEditor/src/@vendor/lang-markdown')}},
  build:{outDir:path.resolve('dist'),emptyOutDir:true,target:'chrome140'},
});
