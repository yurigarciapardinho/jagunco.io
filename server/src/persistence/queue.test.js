// WriteQueue unit tests: ordering, key coalescing, error isolation, flush/close.

import test from "node:test";
import assert from "node:assert/strict";
import { WriteQueue } from "./queue.js";

test("runs jobs in FIFO order", async () => {
    const order = [];
    const q = new WriteQueue();
    q.enqueue("a", async () => order.push("a"));
    q.enqueue("b", async () => order.push("b"));
    q.enqueue("c", async () => order.push("c"));
    await q.flush();
    assert.deepEqual(order, ["a", "b", "c"]);
});

test("coalesces jobs with the same key (latest wins)", async () => {
    const ran = [];
    const q = new WriteQueue();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    q.enqueue("first", async () => { await gate; ran.push("first"); });
    // these pile up while "first" is running: only the last "snap" survives
    q.enqueue("snap", async () => ran.push("snap-1"));
    q.enqueue("snap", async () => ran.push("snap-2"));
    release();
    await q.flush();
    assert.deepEqual(ran, ["first", "snap-2"]);
});

test("a failing job is reported, counted and does not stop the queue", async () => {
    const errors = [];
    const q = new WriteQueue({ onError: (err, key) => errors.push([key, err.message]) });
    const ran = [];
    q.enqueue("bad", async () => { throw new Error("disk exploded"); });
    q.enqueue("good", async () => ran.push("good"));
    await q.flush();
    assert.equal(q.errors, 1);
    assert.equal(q.lastError.message, "disk exploded");
    assert.deepEqual(errors, [["bad", "disk exploded"]]);
    assert.deepEqual(ran, ["good"]);
});

test("flush waits for pending work; close rejects later writes loudly", async () => {
    const errors = [];
    const q = new WriteQueue({ onError: (err) => errors.push(err.message) });
    q.enqueue("a", async () => {});
    await q.close();
    assert.equal(q.closed, true);
    q.enqueue("late", async () => {});
    assert.equal(errors.length, 1);
    assert.match(errors[0], /after close/);
    assert.equal(q.errors, 1);
});
