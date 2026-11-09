// Execute Django's browser scripts in a stateful DOM with upstream jQuery.
const {createInterface} = require("node:readline");
const {readFileSync} = require("node:fs");
const vm = require("node:vm");
const {JSDOM, VirtualConsole} = require("jsdom");
const consoleSink = new VirtualConsole();
let asyncError;
consoleSink.on("jsdomError", error => {asyncError = error;});
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  runScripts:"outside-only", url:"https://bench.invalid/admin/", virtualConsole:consoleSink,
});
const context = dom.getInternalVMContext();
function run(code) { return vm.runInContext(code,context,{timeout:4000}); }
run(readFileSync("django/contrib/admin/static/admin/js/vendor/jquery/jquery.js","utf8"));
run(readFileSync("django/contrib/admin/static/admin/js/jquery.init.js","utf8"));
run(readFileSync("bench_checks/browser.js","utf8"));
async function main() {
  const input = createInterface({input:process.stdin, crlfDelay:Infinity});
  for await (const line of input) {
    try {
      const value=run(JSON.parse(line));
      // jQuery's DOM-ready Deferred and delegated events complete on the event loop.
      await new Promise(done=>setTimeout(done,8));
      if (asyncError) {const error=asyncError; asyncError=undefined; throw error;}
      const primitive = ["boolean","string","number"].includes(typeof value) ? value : null;
      process.stdout.write(JSON.stringify({ok:true,value:primitive})+"\n");
    } catch(error) {
      process.stdout.write(JSON.stringify({ok:false,error:String(error.stack||error)})+"\n");
    }
  }
  dom.window.close();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
