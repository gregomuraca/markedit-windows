#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
const path=require('node:path');

function argumentsFor(input){
 const result=['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'install.ps1'),'-Version','0.3.3'];
 for(let i=0;i<input.length;i++){
  if(input[i]==='--install-only')result.push('-NoLaunch');
  else if(input[i]==='--no-shortcut')result.push('-NoShortcut');
  else if(input[i]==='--dir'){
   const directory=input[++i];
   if(!directory||directory.startsWith('--'))throw new Error('--dir requires an installation directory.');
   result.push('-InstallDirectory',path.resolve(directory));
  } else throw new Error(`Unknown option: ${input[i]}. Use --help.`);
 }
 return result;
}
function main(input=process.argv.slice(2)){
 if(input.includes('--help')){
  process.stdout.write('MarkEdit for Windows 0.3.3\n\nInstalls the verified Windows release and opens MarkEdit.\nOptions:\n  --install-only  Install without opening the app\n  --no-shortcut   Skip the Start menu shortcut\n  --dir PATH      Choose the install directory\n  --help          Show this help\n');return 0;
 }
 if(process.platform!=='win32'){process.stderr.write('MarkEdit requires Windows x64. Download: https://github.com/gregomuraca/markedit-windows/releases/latest\n');return 1;}
 try {
  const args=argumentsFor(input);
  const shell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const child=spawnSync(shell,args,{stdio:'inherit',windowsHide:true,shell:false});
  if(child.error)throw child.error;
  return child.status??1;
 }catch(error){process.stderr.write(error.message+'\n');return 1;}
}
module.exports={argumentsFor,main};
if(require.main===module)process.exitCode=main();
