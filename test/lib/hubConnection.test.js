"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const struct = require("python-struct");

const HubConnection = require("../../src/lib/hubConnection");
const hub = require("../../src/lib/protobuf/hub").proto_hub;
const { noopLogger } = require("../helpers/http");

const SERVER_EVENT = 8; // hubFunctionMap key for ServerEvent
const PING_REQ = 6; // hubFunctionMap key borrowed by the throwing-handler test

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
