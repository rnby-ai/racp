import assert from "node:assert/strict";
import test from "node:test";
import {
  RacpBridgeError,
  createRacpBridge,
  createRacpBridgeStub,
} from "@rnby/racp-bridge";

function fakeClient() {
  return {
    startCalls: 0,
    stopCalls: 0,
    messageHandler: null,
    async start() {
      this.startCalls += 1;
    },
    async stop() {
      this.stopCalls += 1;
    },
    async send() {},
    async query() {},
    onMessage(handler) {
      this.messageHandler = handler;
      return () => undefined;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("bridge stub is inert until an explicit daemon driver is supplied", async () => {
  const stub = createRacpBridgeStub(fakeClient());
  await assert.rejects(
    stub.start(),
    (error) => error instanceof RacpBridgeError && error.code === "driver_required",
  );
  assert.equal(stub.snapshot().state, "faulted");
  assert.equal(stub.snapshot().address, null);
});

test("typed bridge delegates lifecycle to a caller-owned driver", async () => {
  const client = fakeClient();
  let closed = 0;
  const bridge = createRacpBridge(client, {
    async start(context) {
      assert.equal(context.client, client);
      assert.equal(context.signal.aborted, false);
      return {
        address: "unix:///tmp/example.sock",
        close: async () => {
          closed += 1;
        },
      };
    },
  });
  await bridge.start();
  assert.equal(bridge.snapshot().state, "running");
  assert.equal(bridge.snapshot().address, "unix:///tmp/example.sock");
  await bridge.stop();
  assert.equal(closed, 1);
  assert.equal(client.stopCalls, 1);
});

test("bridge preserves message handler dispositions through the driver context", async () => {
  const client = fakeClient();
  const dispositions = [false, "retry", "delivered", "acknowledged"];
  let unsubscribeCalls = 0;
  client.onMessage = function onMessage(handler) {
    this.messageHandler = handler;
    return () => {
      unsubscribeCalls += 1;
    };
  };

  const bridge = createRacpBridge(client, {
    async start(context) {
      for (const disposition of dispositions) {
        const unsubscribe = context.onMessage(async () => disposition);
        assert.equal(await client.messageHandler({}), disposition);
        unsubscribe();
      }
      return { close: async () => undefined };
    },
  });

  await bridge.start();
  await bridge.stop();
  assert.equal(unsubscribeCalls, dispositions.length);
});

test("stop during driver startup closes a late handle without resurrecting running", async () => {
  const client = fakeClient();
  const driverStarted = deferred();
  const returnHandle = deferred();
  const states = [];
  let lateHandleCloseCalls = 0;
  let driverSignal;
  const bridge = createRacpBridge(client, {
    async start(context) {
      driverSignal = context.signal;
      driverStarted.resolve();
      return returnHandle.promise;
    },
  });
  bridge.onStateChange((state) => states.push(state));

  const startPromise = bridge.start();
  await driverStarted.promise;
  const stopPromise = bridge.stop();
  assert.equal(bridge.state, "stopping");
  assert.equal(driverSignal.aborted, true);

  returnHandle.resolve({
    address: "unix:///tmp/too-late.sock",
    close: async () => {
      lateHandleCloseCalls += 1;
    },
  });
  await Promise.all([startPromise, stopPromise]);

  assert.equal(lateHandleCloseCalls, 1);
  assert.equal(client.stopCalls, 1);
  assert.deepEqual(states, ["starting", "stopping", "stopped"]);
  assert.deepEqual(bridge.snapshot(), {
    state: "stopped",
    address: null,
    lastError: null,
  });
});

test("shutdown still stops the client when the driver handle fails to close", async () => {
  const client = fakeClient();
  const closeFailure = new Error("socket close failed");
  const bridge = createRacpBridge(client, {
    async start() {
      return {
        close: async () => {
          throw closeFailure;
        },
      };
    },
  });
  await bridge.start();

  await assert.rejects(bridge.stop(), (error) => {
    assert.equal(error instanceof RacpBridgeError, true);
    assert.equal(error.code, "stop_failed");
    assert.equal(error.message, "RACP bridge driver handle failed to close.");
    assert.equal(error.cause, closeFailure);
    return true;
  });
  assert.equal(client.stopCalls, 1);
  assert.equal(bridge.state, "stopped");
  assert.equal(
    bridge.snapshot().lastError,
    "RACP bridge driver handle failed to close.",
  );
});

test("shutdown reports both driver and client cleanup failures", async () => {
  const client = fakeClient();
  const closeFailure = new Error("driver close failed");
  const clientFailure = new Error("client stop failed");
  client.stop = async function stop() {
    this.stopCalls += 1;
    throw clientFailure;
  };
  const bridge = createRacpBridge(client, {
    async start() {
      return {
        close: async () => {
          throw closeFailure;
        },
      };
    },
  });
  await bridge.start();

  await assert.rejects(bridge.stop(), (error) => {
    assert.equal(error instanceof RacpBridgeError, true);
    assert.equal(error.code, "stop_failed");
    assert.equal(
      error.message,
      "RACP bridge shutdown failed in multiple cleanup phases.",
    );
    assert.equal(error.cause instanceof AggregateError, true);
    assert.deepEqual(error.cause.errors, [closeFailure, clientFailure]);
    return true;
  });
  assert.equal(client.stopCalls, 1);
  assert.equal(bridge.state, "stopped");
});
