const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {argumentsFor,installerEnvironment}=require('./cli.cjs');
test('defaults invoke the bundled installer with a pinned app release',()=>{
 const args=argumentsFor([]);assert.ok(args.includes(path.join(__dirname,'install.ps1')));assert.deepEqual(args.slice(-2),['-Version','0.4.0']);
});
test('installation flags are forwarded as separate arguments',()=>{
 const args=argumentsFor(['--install-only','--no-shortcut','--dir','Folder with spaces']);
 assert.ok(args.includes('-NoLaunch'));assert.ok(args.includes('-NoShortcut'));assert.equal(args.at(-1),path.resolve('Folder with spaces'));
});
test('invalid options and missing directories fail before starting an installer',()=>{
 assert.throws(()=>argumentsFor(['--dir']),/requires/);assert.throws(()=>argumentsFor(['--dir','--install-only']),/requires/);assert.throws(()=>argumentsFor(['--unknown']),/Unknown/);
});

test('PowerShell module paths are reset without changing the parent environment',()=>{
 const original={PSModulePath:'PowerShell7 modules',Path:'Windows tools',TEMP:'temp'};
 assert.deepEqual(installerEnvironment(original),{Path:'Windows tools',TEMP:'temp'});
 assert.equal(original.PSModulePath,'PowerShell7 modules');
 assert.deepEqual(installerEnvironment({PSMODULEPATH:'custom',Path:'tools'}),{Path:'tools'});
});