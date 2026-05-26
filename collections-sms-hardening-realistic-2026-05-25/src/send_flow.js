export function createDeferredContext() {
  var jobs = [];
  return {
    waitUntil: function(promise) {
      jobs.push(Promise.resolve(promise));
    },
    async flushDeferred() {
      await Promise.all(jobs);
    },
    deferredCount: function() {
      return jobs.length;
    }
  };
}

async function maybeCall(fn, arg) {
  if (typeof fn !== "function") return null;
  return await fn(arg);
}

export async function sendSmsCurrentFlow(opts) {
  opts = opts || {};
  var started = Date.now();
  var provider = await maybeCall(opts.sendProvider, opts.message);

  await maybeCall(opts.writeLedger, provider);
  await maybeCall(opts.writeThread, provider);
  await maybeCall(opts.writeContact, provider);
  await maybeCall(opts.updateTenant, provider);
  await maybeCall(opts.commitGate, provider);

  return {
    ok: true,
    providerAccepted: true,
    provider,
    elapsedMs: Date.now() - started,
    deferred: false
  };
}

// Run a deferred bookkeeping job in error-isolation. One failure must NOT
// poison Promise.all in flushDeferred() — that would mark other jobs as failed
// even when they succeeded. The optional onDeferredError sink lets the host app
// log / alert / retry without re-patching this file.
//
// In a real Stella deployment, the production-grade move is to swap this
// in-process queue for a durable queue (BullMQ on Redis) so jobs survive a
// process crash. The interface below is shaped so that swap is a one-file
// change in createDeferredContext — sendSmsOptimizedFlow itself stays put.
// See NOTES.md "Deferred-write durability".
function deferJob(ctx, jobName, fn, onError) {
  ctx.waitUntil(
    Promise.resolve()
      .then(fn)
      .catch(function(err) {
        if (typeof onError === "function") {
          // Guard the sink itself — a throwing logger must not crash the chain.
          try { onError(err, jobName); } catch (_) {}
        }
        return null;
      })
  );
}

export async function sendSmsOptimizedFlow(opts) {
  opts = opts || {};
  var started = Date.now();
  // ctx is normally provided by the caller so they can flushDeferred() in tests
  // or before shutdown. Falling back to an internal one keeps the function
  // robust if a caller forgets — deferred work still runs, just unobservable.
  var ctx = opts.ctx || createDeferredContext();
  var onDeferredError = opts.onDeferredError;

  // BLOCKING — provider acceptance is the only thing the UI must wait on.
  // We cannot defer this: every downstream bookkeeping call needs the provider
  // response (message id, status) as its argument. If sendProvider rejects, the
  // SMS never went out, so we surface the error and register no deferred work.
  var provider = await maybeCall(opts.sendProvider, opts.message);

  // DEFERRED — post-send bookkeeping settles in the background after we return.
  // commitGate is treated as a post-send commit-marker (it runs after
  // sendProvider in the original flow, which is the only consistent reading
  // within the given API). The pre-send dedupe check that would actually
  // prevent duplicate sends is a separate concern flagged in NOTES.md.
  deferJob(ctx, "writeLedger",  function () { return maybeCall(opts.writeLedger,  provider); }, onDeferredError);
  deferJob(ctx, "writeThread",  function () { return maybeCall(opts.writeThread,  provider); }, onDeferredError);
  deferJob(ctx, "writeContact", function () { return maybeCall(opts.writeContact, provider); }, onDeferredError);
  deferJob(ctx, "updateTenant", function () { return maybeCall(opts.updateTenant, provider); }, onDeferredError);
  deferJob(ctx, "commitGate",   function () { return maybeCall(opts.commitGate,   provider); }, onDeferredError);

  return {
    ok: true,
    providerAccepted: true,
    provider: provider,
    elapsedMs: Date.now() - started,
    deferred: true
  };
}
