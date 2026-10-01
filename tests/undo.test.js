"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("runtime undo uses the shared BizOps target for every receipt account after selection changes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mailkeeper-undo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, "commands.jsonl");
  const binary = path.join(root, "himalaya");
  fs.writeFileSync(binary, `#!${process.execPath}\nconst fs=require('fs'); const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[0]!=='message'||args[1]!=='move'||args[args.indexOf('-c')+1]!=='/fixture/bizops.toml')process.exit(91);
console.log('[]');`, { mode: 0o700 });
  const script = path.join(root, "undo.cjs");
  fs.writeFileSync(script, `const { MailKeeperService }=require(${JSON.stringify(path.resolve(__dirname, "../runtime/service"))});
const store=new Map(); const workspace={id:1,slug:'fixture'};
const api={getConfig:()=>({EMAIL_ACCOUNTS:['new-selection'],AGENT:'cursor'}),getStore:()=>({get:async k=>store.get(k),set:async(k,v)=>store.set(k,v)}),
workspaces:{get:async()=>workspace},heartbeat:{upsertManagedTask:async()=>{}},email:{getHimalayaTarget:async()=>({source:'bizops',configPath:'/fixture/bizops.toml'})}};
store.set('ws-1-run-original',{runId:'original',scope:{accounts:['a','b'],configPath:'/fixture/bizops.toml'},actions:[
{kind:'move',account:'a',uid:'1',from:'INBOX',to:'Archive'},{kind:'move',account:'b',uid:'2',from:'INBOX',to:'Auto/Alerts'}]});
const service=new MailKeeperService(api);
(async()=>{ const result=await service.undoRun(workspace,{runId:'original'},{id:7});
store.set('ws-1-run-changed',{actions:[{kind:'move',account:'a',uid:'3',from:'INBOX',to:'Archive'}],scope:{accounts:['a'],configPath:'/fixture/old.toml'}});
let changedCode; try { await service.undoRun(workspace,{runId:'changed'},{id:7}); } catch(error) { changedCode=error.code; }
store.set('ws-1-run-legacy',{actions:[{kind:'move',uid:'4',from:'INBOX',to:'Archive'}]});
let legacyCode; try { await service.undoRun(workspace,{runId:'legacy'},{id:7}); } catch(error) { legacyCode=error.code; }
console.log(JSON.stringify({result,changedCode,legacyCode})); })().catch(()=>process.exit(1));`);
  const result = spawnSync(process.execPath, [script], { encoding: "utf8",
    env: { ...process.env, MAILKEEPER_HIMALAYA_BIN: binary, HIMALAYA_CONFIG: "/wrong/environment.toml" } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.result.reversed, 2); assert.deepEqual(output.result.skipped, []);
  assert.equal(output.changedCode, "MAILKEEPER_TARGET_CHANGED");
  assert.equal(output.legacyCode, "MAILKEEPER_UNDO_SCOPE_UNKNOWN", "current selection cannot identify a legacy receipt account");
  const commands = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(commands.length, 2, "changed target must not dispatch another move");
  assert.deepEqual(commands.map((args) => args[args.indexOf("-a") + 1]), ["a", "b"]);
  assert.ok(commands.every((args) => args[args.indexOf("-c") + 1] === "/fixture/bizops.toml"));
  assert.ok(commands.every((args) => args[4] === "INBOX"));
  assert.deepEqual(commands.map((args) => args[3]), ["Archive", "Auto/Alerts"]);
});
