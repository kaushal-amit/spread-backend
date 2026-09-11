'use strict';
/**
 * ============================================================================
 *  lib/events.js — "something changed" (the socket plan's write signal)
 * ============================================================================
 * A write path — a trading write, PUT /gates, a slot swap, a halt, a wake-up —
 * announces WHICH parts of the terminal's state it touched. socket.js listens
 * and pushes a partial snapshot to the room (debounced 5 s), so the operator
 * sees their own order the moment it is booked, and no client ever polls to
 * discover its own write.
 *
 * Parts are the snapshot's section names (services/snapshot.js PARTS). No
 * parts = everything.
 * ============================================================================
 */
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(20);

/** @param {string[]} parts  snapshot sections touched; [] or undefined = all */
function changed(parts = [], reason = 'write') {
  bus.emit('changed', { parts: Array.isArray(parts) ? parts : [], reason, at: Date.now() });
}

module.exports = { bus, changed };
