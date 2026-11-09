import assert from "node:assert/strict";
import { binding, change, count, keyFactory, redis } from "./bench-public/priority.mjs";

const bucket = 2**32;
const create = (prefix, id, priority = 0) => redis("HSET", prefix + id, "priority", priority, "data", "unchanged");

async function keyNamespace() {
  const C = await keyFactory();
  const names = ["", "active", "wait", "waiting-children", "paused", "id", "delayed", "prioritized",
    "stalled-check", "completed", "failed", "stalled", "repeat", "limiter", "meta", "events", "pc", "marker", "de"];
  for (const [prefix, supplied] of [["bull", undefined],["{tenant}:v2","{tenant}:v2"],["",""]]) {
    const factory = new C(supplied);
    const queue = "email-队列";
    const expected = prefix + ":" + queue;
    assert.equal(factory.getQueueQualifiedName(queue), expected);
    assert.deepEqual(factory.getKeys(queue), Object.fromEntries(names.map(k => [k, expected + ":" + k])));
    assert.equal(factory.toKey(queue, "custom:42"), expected + ":custom:42");
  }
}

function relocation() {
  const p = "move:";
  create(p,"a"); create(p,"b"); create(p,"c");
  redis("LPUSH",p+"wait","a","b","c");
  for (const id of ["a","b"]) assert.equal(change(p,id,4),0);
  assert.equal(Number(redis("ZSCORE",p+"prioritized","a")), 4*bucket+1);
  assert.equal(Number(redis("ZSCORE",p+"prioritized","b")), 4*bucket+2);
  assert.equal(change(p,"c",4,true),0);
  assert.deepEqual(redis("ZRANGE",p+"prioritized",0,-1),["c","a","b"]);
  assert.equal(Number(redis("ZSCORE",p+"prioritized","c")),4*bucket);
  assert.equal(redis("GET",p+"pc"),"2");
  assert.deepEqual(redis("ZRANGE",p+"marker",0,-1),["0"]);
  assert.equal(change(p,"a",0),0);
  assert.equal(change(p,"b",0,true),0);
  assert.deepEqual(redis("LRANGE",p+"wait",0,-1),["a","b"]);
  assert.equal(redis("HGET",p+"a","data"),"unchanged");
}

function stateAndMarker() {
  assert.equal(change("u:","missing",2),-1);
  assert.equal(redis("DBSIZE"),0);
  for (const mode of ["paused","maxed","ready"]) {
    const p = mode+":";
    create(p,"present");
    redis("LPUSH",p+"wait","present");
    if (mode === "paused") redis("HSET",p+"meta","paused",1);
    if (mode === "maxed") {
      redis("HSET",p+"meta","concurrency",1);
      redis("LPUSH",p+"active","other");
    }
    assert.equal(change(p,"present",1),0);
    assert.equal(redis("ZCARD",p+"marker"),mode === "ready" ? 1 : 0);
    assert.deepEqual(redis("ZRANGE",p+"prioritized",0,-1),["present"]);
    create(p,"working");
    redis("LPUSH",p+"active","working");
    assert.equal(change(p,"working",9),0);
    assert.equal(redis("HGET",p+"working","priority"),"9");
    assert.equal(redis("ZSCORE",p+"prioritized","working"),null);
    assert.equal(redis("LINDEX",p+"active",0),"working");
  }
}

function countBoundaries() {
  const p="buckets:";
  redis("LPUSH",p+"wait","w1","w2");
  redis("LPUSH",p+"paused","p1");
  redis("ZADD",p+"prioritized",bucket,"oneFirst",2*bucket-1,"oneLast",2*bucket,"twoFirst",
    3*bucket-1,"twoLast",3*bucket,"three");
  assert.deepEqual(count(p,[2,1,0,3,1,99]),[2,2,2,1,2,0]);
  assert.deepEqual(count(p,[]),[]);
}

async function clientRoundTrip() {
  const orders = await binding("{acme}","orders"), refunds = await binding("{acme}","refunds");
  for (const backend of [orders,refunds]) {
    const p = backend.queue.toKey("");
    for (const id of ["42","71"]) { create(p,id); redis("LPUSH",p+"wait",id); }
  }
  await orders.changePriority("42",6);
  await orders.changePriority("71",6,true);
  assert.deepEqual(await orders.getCountsPerPriority([0,6,5]),[0,2,0]);
  assert.deepEqual(await refunds.getCountsPerPriority([0,6]),[2,0]);
  assert.deepEqual(redis("ZRANGE",orders.queue.keys.prioritized,0,-1),["71","42"]);
  await orders.changePriority("42",0);
  assert.deepEqual(await orders.getCountsPerPriority([6,0]),[1,1]);
  await assert.rejects(orders.changePriority("absent",1), /-1.*absent/);
}

const groups = [["queue-namespace",keyNamespace], ["reprioritize-order",relocation],
  ["state-and-marker",stateAndMarker], ["count-score-bounds",countBoundaries], ["client-round-trip",clientRoundTrip]];
const checks = [];
for (const [id, test] of groups) {
  redis("FLUSHDB");
  try {
    await test();
    checks.push({id, passed:true});
  } catch (err) {
    checks.push({id, passed:false, error:String(err).slice(0,1000)});
  }
}
