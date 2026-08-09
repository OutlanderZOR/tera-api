"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const struct = require("python-struct");

const HubConnection = require("../../src/lib/hubConnection");
const hub = require("../../src/lib/protobuf/hub").proto_hub;
const HubError = require("../../src/lib/hubError");
const { serverCategory } = require("../../src/lib/teraPlatformGuid");
const { noopLogger } = require("../helpers/http");

const REGISTER_ANS = 2; // hubFunctionMap key for RegisterAns
const SERVER_EVENT = 8; // hubFunctionMap key for ServerEvent
const PING_REQ = 6; // hubFunctionMap key borrowed by the throwing-handler test

const BIAS_LIMIT = 10000; // register() gives up once biasCount climbs past this

const CONNECTED = 1;
const DISCONNECTED = 2;

const SERVER_ID = 0x01000005;
const CATEGORY = (SERVER_ID & 0xFF000000) >> 24;

/**
 * Builds one wire frame the way recv() expects to read it: a uint16 total size, a uint16 message id,
 * then the encoded body. Framing recv() directly is what lets these tests run without a hub socket.
 */
function frame(msgId, body = Buffer.alloc(0)) {
	const msg = Buffer.concat([struct.pack("H", msgId), Buffer.from(body)]);

	return Buffer.concat([struct.pack("H", struct.sizeOf("H") + msg.length), msg]);
}

function serverEventFrame(serverId, event) {
	return frame(SERVER_EVENT, hub.ServerEvent.encode({ serverId, event }).finish());
}

/**
 * A logger that records what it was handed, so tests can assert the error was reported, not swallowed.
 * Every level other than error falls through to noopLogger, which answers any property with a no-op.
 */
function createRecordingLogger() {
	const errors = [];

	return Object.assign(Object.create(noopLogger), {
		errors,
		error: err => errors.push(err)
	});
}

function createConnection(logger = createRecordingLogger()) {
	return { conn: new HubConnection("127.0.0.1", 11001, { logger }), logger };
}

/**
 * Puts a connection into the state register() expects without a socket: connected, with a stub that
 * reports a local endpoint and accepts writes.
 */
function createRegistrableConnection() {
	const { conn, logger } = createConnection();

	conn.serviceId = serverCategory.webcstool;
	conn.connected = true;
	conn.socket = {
		socket: { localAddress: "127.0.0.1", localPort: 12345 },
		write: async () => undefined
	};

	return { conn, logger };
}

/** Fails the promise rather than letting an unsettled one stall the runner. */
function withTimeout(promise, ms) {
	let timer = null;

	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise((resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`promise did not settle within ${ms} ms`)), ms);
		})
	]);
}

/** Resolves once every pending microtask has run, so register()'s listener is attached. */
function flushMicrotasks() {
	return new Promise(resolve => setImmediate(resolve));
}

describe("HubConnection.recv", () => {
	// Both of these assert on the error log as well as on the state. recv() catches handler throws, so
	// without the log assertion a swallowed TypeError would read as success.
	test("DISCONNECTED ServerEvent removes the server without throwing", () => {
		const { conn, logger } = createConnection();

		conn.recv(serverEventFrame(SERVER_ID, CONNECTED));
		assert.ok(conn.watchServerCategories[CATEGORY].has(SERVER_ID));

		conn.recv(serverEventFrame(SERVER_ID, DISCONNECTED));

		assert.deepEqual(logger.errors, []);
		assert.equal(conn.watchServerCategories[CATEGORY].has(SERVER_ID), false);
		assert.equal(conn.watchServerCategories[CATEGORY].size, 0);
	});

	test("DISCONNECTED ServerEvent for an unknown category does not throw", () => {
		const { conn, logger } = createConnection();

		conn.recv(serverEventFrame(SERVER_ID, DISCONNECTED));

		assert.deepEqual(logger.errors, []);
		assert.equal(conn.watchServerCategories[CATEGORY], undefined);
	});

	test("a handler that throws does not propagate out of recv", () => {
		const { conn, logger } = createConnection();

		conn.hubFunctionMap[PING_REQ] = () => {
			throw new Error("handler blew up");
		};

		// The throwing frame is followed by a valid one, so the test also proves the loop keeps going.
		conn.recv(Buffer.concat([
			frame(PING_REQ),
			serverEventFrame(SERVER_ID, CONNECTED)
		]));

		assert.equal(logger.errors.length, 1);
		assert.match(String(logger.errors[0]), /handler blew up/);
		assert.ok(conn.watchServerCategories[CATEGORY].has(SERVER_ID));
	});
});

describe("HubConnection.register", () => {
	test("register rejects instead of hanging once biasCount exceeds its limit", async () => {
		const { conn } = createRegistrableConnection();

		conn.biasCount = BIAS_LIMIT; // the next failed answer pushes it past the limit

		const registered = conn.register();

		// register() computes uniqueServerId synchronously, but attaches its listener only after
		// send() resolves, so the answer has to wait for the microtask queue to drain.
		await flushMicrotasks();

		// A RegisterAns with a falsy result makes the handler emit null, which is the give-up path.
		conn.recv(frame(REGISTER_ANS, hub.RegisterAns.encode({ result: false }).finish()));

		await assert.rejects(withTimeout(registered, 1000), err => {
			assert.ok(err instanceof HubError, `expected HubError, got ${err}`);
			assert.match(err.message, /Can't register server/);
			return true;
		});

		assert.equal(conn.isRegistered, false);
	});
});
