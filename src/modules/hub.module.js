"use strict";

/**
 * @typedef {HubFunctions} hub
 * @typedef {import("../app").modules} modules
 */

const env = require("../utils/env");
const { createLogger } = require("../utils/logger");
const HubFunctions = require("../lib/hubFunctions");
const serverCategory = require("../lib/teraPlatformGuid").serverCategory;

/**
 * @param {modules} modules
 */
module.exports = async () => {
	const hub = new HubFunctions(
		env.string("HUB_HOST"),
		env.number("HUB_PORT"),
		serverCategory.webcstool, {
			logger: createLogger("Hub", { colors: { debug: "magenta" } })
		}
	);

	// Not awaited: the hub must not be a boot-blocking dependency. connect() arms its own 10 second
	// retry interval synchronously and swallows connect errors, so registration completes in the
	// background while the API listeners bind on schedule.
	hub.connect();

	return hub;
};