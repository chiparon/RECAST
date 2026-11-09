import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const commandPaths = {
  changePriority: "src/commands/changePriority-7.lua",
  getCountsPerPriority: "src/commands/getCountsPerPriority-2.lua",
};
const socket = "/tmp/bench-redis.sock";

export function redis(...args) {
  const response = execFileSync("redis-cli", ["-s", socket, "--json", ...args.map(String)], {encoding:"utf8"});
  if (response.startsWith("error:")) throw Error(response.trim());
  return JSON.parse(response);
}

export async function startRedis() {
  execFileSync("redis-server", ["--port", "0", "--unixsocket", socket, "--dir", "/tmp",
    "--daemonize", "yes", "--pidfile", "/tmp/redis.pid", "--logfile", "/tmp/redis.log",
    "--save", "", "--appendonly", "no"]);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(socket)) {
      if (redis("PING") === "PONG") return;
    }
    await sleep(10);
  }
  throw Error("Private Redis instance failed to start: " + readFileSync("/tmp/redis.log", "utf8"));
}

// BullMQ expands local Lua include directives at build time, once per file.
export function lua(name) {
  const included = new Set();
  const root = resolve("src/commands");
  function load(path) {
    if (!path.startsWith(root + "/")) throw Error("Include outside src/commands");
    if (included.has(path)) return "";
    included.add(path);
    return readFileSync(path, "utf8").replace(/^[\t ]*---[\t ]*@include\s+"([^"]+)"[^\n]*$/gm,
      (_directive, relative) => load(resolve(dirname(path), relative + (relative.endsWith(".lua") ? "" : ".lua"))));
  }
  return load(resolve(commandPaths[name]));
}

export function call(name, keys, args) {
  return redis("EVAL", lua(name), keys.length, ...keys, ...args);
}
export function change(prefix, id, priority, lifo = false) {
  const keys = ["wait","paused","meta","prioritized","active","pc","marker"].map(k => prefix + k);
  return call("changePriority", keys, [priority, prefix, id, Number(lifo)]);
}
export function count(prefix, priorities) {
  return call("getCountsPerPriority", [prefix + "wait", prefix + "prioritized"], priorities);
}
export async function keyFactory() {
  const mod = await import(pathToFileURL(resolve("src/classes/queue-keys.ts")));
  return mod.QueueKeys;
}

// Use the upstream TS backend's real call-site methods. The scoped adapter
// replaces the transport with EVAL on the container's private Redis socket.
export async function binding(prefix, queueName) {
  const source = readFileSync("src/classes/redis-queue-backend.ts", "utf8");
  const methods = ["getCountsPerPriorityArgs","getCountsPerPriority","changePriorityArgs","changePriority"];
  const declarations = methods.map(name => {
    const match = source.match(new RegExp("^  (?:protected |public |async )*" + name + "\\([\\s\\S]*?^  \\}", "m"));
    if (!match) throw Error("Missing pinned TS backend method: " + name);
    return match[0];
  });
  const body = stripTypeScriptTypes("class Backend {\n" + declarations.join("\n") + "\n}", {mode:"transform"});
  const backend = new (Function("return (" + body + ")")())();
  const QueueKeys = await keyFactory();
  const factory = new QueueKeys(prefix);
  backend.queue = {keys: factory.getKeys(queueName), toKey: type => factory.toKey(queueName, type), client: null};
  backend.execCommand = async (_client, name, args) => {
    const n = Number(commandPaths[name].match(/-(\d+)\.lua$/)[1]);
    return call(name, args.slice(0,n), args.slice(n));
  };
  backend.finishedErrors = ({code, jobId}) => Error("Redis code " + code + " for job " + jobId);
  return backend;
}

export async function publicChecks(mode) {
  if (mode === "compile") {
    await keyFactory();
    for (const command of Object.keys(commandPaths)) assert.match(redis("SCRIPT", "LOAD", lua(command)), /^[a-f0-9]{40}$/);
    return;
  }
  if (mode === "keys" || mode === "all") {
    const QueueKeys = await keyFactory(), q = new QueueKeys("work");
    assert.equal(q.getQueueQualifiedName("mail"), "work:mail");
    assert.equal(q.getKeys("mail").prioritized, "work:mail:prioritized");
    assert.equal(q.getKeys("mail")[""], "work:mail:");
  }
  if (mode === "change" || mode === "all") {
    redis("HSET","p:j","priority",0);
    redis("LPUSH","p:wait","j");
    assert.equal(change("p:","j",3),0);
    assert.equal(redis("LLEN","p:wait"),0);
    assert.equal(redis("ZRANGE","p:prioritized",0,-1)[0],"j");
    assert.equal(redis("HGET","p:j","priority"),"3");
  }
  if (mode === "counts" || mode === "all") {
    redis("LPUSH","c:wait","a","b");
    redis("ZADD","c:prioritized",2 * 2**32 + 1,"r");
    assert.deepEqual(count("c:",[0,2,4]),[2,1,0]);
  }
  if (mode === "all") {
    const backend = await binding("api","mail");
    redis("HSET","api:mail:j","priority",0);
    redis("LPUSH","api:mail:wait","j");
    await backend.changePriority("j",5);
    assert.deepEqual(await backend.getCountsPerPriority([0,5]), [0,1]);
  }
}
