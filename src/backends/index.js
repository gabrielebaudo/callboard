'use strict';

/**
 * Registry of show-control backends. Every factory here returns the same
 * contract: { start, stop, applyConfig, refreshMarkersFor, refreshAll,
 * capabilities }. `capabilities.markers` tells the client whether this
 * backend has cue/marker detail worth showing (department filters, marker
 * flags, running order); `capabilities.departments` whether department
 * prefixes are meaningful for it. A backend with markers:false still
 * drives the track strip, clock, and playhead -- just nothing below.
 */
const REGISTRY = {
  qlab: require('./qlab'),
  vmix: require('./vmix'),
  mock: require('./mock')
};

function createBackend(type, deps) {
  const factory = REGISTRY[type];
  if (!factory) {
    throw new Error(`Unknown backend type: "${type}"`);
  }
  return factory(deps);
}

module.exports = { createBackend, REGISTRY };
