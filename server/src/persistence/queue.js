// WRITE QUEUE
// Serializes asynchronous persistence writes. Jobs are keyed: enqueueing the same key
// twice before it runs replaces the pending job (a later snapshot supersedes an older
// one), so a burst of save() calls collapses into at most one queued job plus the one
// currently running. Job errors are caught and reported through onError: a failed write
// must never crash the game loop, and the queue keeps draining after a failure.

export class WriteQueue {

    constructor({ onError } = {}) {
        this.onError = onError || ((err, key) => console.error(`persistence: write "${key}" failed:`, err));
        this.pending = new Map();     // key -> job (FIFO, coalesced by key)
        this.running = false;
        this.closed = false;
        this.errors = 0;
        this.lastError = null;
        this.draining = null;
        this.fenced = false;
        this.resumeWaiters = [];
    }

    // key: coalescing key (e.g. "store", "chat", "bans"); job: async () => void
    enqueue(key, job) {
        if (this.closed) {
            // Writes after close are dropped loudly instead of silently lost.
            const err = new Error(`persistence: write "${key}" enqueued after close`);
            this.errors++;
            this.lastError = err;
            this.onError(err, key);
            return;
        }
        this.pending.set(key, job);
        if (!this.running && !this.fenced) this.draining = this.#drain();
    }

    // Critical commands cannot coalesce and must receive their own failure.
    runExclusive(job) {
        if (this.closed) return Promise.reject(new Error("queue_closed"));
        return new Promise((resolve, reject) => {
            this.enqueue(Symbol("command"), async () => {
                try { resolve(await job()); } catch (error) { reject(error); }
            });
        });
    }

    pause() { this.fenced = true; }
    resume() {
        this.fenced = false;
        this.resumeWaiters.splice(0).forEach(resolve => resolve());
        if (this.pending.size && !this.running) this.draining = this.#drain();
    }

    async #drain() {
        this.running = true;
        try {
            while (this.pending.size && !this.fenced) {
                const [key, job] = this.pending.entries().next().value;
                this.pending.delete(key);
                try {
                    await job();
                } catch (err) {
                    this.errors++;
                    this.lastError = err;
                    this.onError(err, key);
                }
            }
        } finally {
            this.running = false;
        }
    }

    // Wait until everything queued so far (and anything queued while draining) is written.
    async flush() {
        for (;;) {
            if (this.fenced) await new Promise(resolve => this.resumeWaiters.push(resolve));
            if (this.draining) await this.draining;
            if (!this.pending.size && !this.running) return;
        }
    }

    // No new writes after this; resolves when the queue is empty.
    async close() {
        this.closed = true;
        await this.flush();
    }
}
