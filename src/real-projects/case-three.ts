import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Check, Command, RealFixture } from "./types.ts";

const execute = promisify(execFile);
const local = (name: string) => fileURLToPath(new URL("./case-three/" + name, import.meta.url));
const command = (mode: string): Command => ({
  executable: process.execPath, args: [local("driver.mjs"), mode], timeoutMs: 75_000,
});
const modules = [
  {name:"keys", path:"src/classes/queue-keys.ts", language:"TypeScript", description:
    "Deliver the full QueueKeys map and public API. Qualify the queue as prefix:name (default prefix bull). " +
    "toKey adds a colon and the requested type, including the empty type. getKeys must return that key for every BullMQ suffix: " +
    "the empty string, active, wait, waiting-children, paused, id, delayed, prioritized, stalled-check, completed, failed, " +
    "stalled, repeat, limiter, meta, events, pc, marker, de. Preserve caller-provided prefixes, names and types verbatim."},
  {name:"change", path:"src/commands/changePriority-7.lua", language:"Lua", dependsOn:["keys"], description:
    "This .lua module runs in Redis and must be written in Lua. The host's structural module label may display TypeScript. " +
    "Implement the complete atomic Redis changePriority command using its header ABI and the existing BullMQ Lua includes. " +
    "Return -1 without writing if the prefixed job hash does not exist. Otherwise remove the job once from prioritized, " +
    "or from wait, and reinsert only if removed. Priority zero uses LPUSH in FIFO mode or RPUSH in LIFO mode. " +
    "Positive priority uses a sorted score of priority * 2^32 plus the incremented pc modulo 2^32 for FIFO, " +
    "or priority * 2^32 for LIFO without incrementing pc. When inserting in wait or a positive FIFO bucket, add marker " +
    "member '0' at score 0 only if not paused or at concurrency capacity. Positive LIFO uses the existing front-of-bucket helper. " +
    "Record the requested priority in the job hash even for jobs outside wait/prioritized. Preserve other state. Return 0."},
  {name:"counts", path:"src/commands/getCountsPerPriority-2.lua", language:"Lua", dependsOn:["keys"], description:
    "This .lua module runs in Redis and must be written in Lua. The host's structural module label may display TypeScript. " +
    "Implement the complete atomic count read command declared in its header. For each supplied priority in argument order, " +
    "return the wait-list length for 0 or count the prioritized set members in that priority's 2^32-wide score bucket. " +
    "Preserve duplicates, return zero for absent buckets, and return an empty result for an empty request."},
];
export const fixture: RealFixture = {
  id:"bullmq-priority", title:"BullMQ priority queue delivery",
  upstream:{url:"https://github.com/taskforcesh/bullmq.git",commit:"b2aa09331e60ca92cefcf78cca7cf0b706dc7eb4"},
  requirement:"Restore BullMQ's priority queue feature across the TypeScript key namespace and the Redis Lua read and write commands. " +
    "The upstream RedisQueueBackend dispatch methods and native Redis 7.2.5 must agree on queue names, key order and priority scores. " +
    "Deliver only the three named production modules. " + modules.map(m => m.path + ": " + m.description).join(" ") +
    " The existing includes live in src/commands/includes and can be used via BullMQ's local @include directives. See bench-public/priority.mjs for the public smoke suite.",
  modules,
  references:["src/classes/redis-queue-backend.ts","src/commands/includes/getPriorityScore.lua",
    "src/commands/includes/addJobWithPriority.lua","src/commands/includes/isQueuePausedOrMaxed.lua",
    "src/commands/includes/addJobInTargetList.lua","src/commands/includes/pushBackJobWithPriority.lua",
    "src/commands/includes/addBaseMarkerIfNeeded.lua","bench-public/priority.mjs"],
  compile:command("compile"), test:command("all"),
  moduleTests:{keys:command("keys"),change:command("change"),counts:command("counts")},
  async prepare(root, variant) {
    await execute("python", [local("prepare.py"),root,variant], {timeout:360_000,windowsHide:true});
  },
  async grade(root) {
    const {stdout} = await execute(process.execPath,command("external").args,{cwd:root,timeout:75_000,windowsHide:true});
    const checks: Check[] = JSON.parse(stdout);
    if (checks.length !== 5) throw Error("Missing BullMQ acceptance groups");
    return checks;
  },
  productionFiles: path => path.startsWith("src/") && /\.(ts|lua)$/.test(path),
};
