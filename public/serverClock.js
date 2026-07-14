// Maps server-side timestamps into the browser's wall-clock domain.
//
// The playback sample itself is taken on the Node server, then delivered to
// the browser later over Socket.IO. Interpolating from the browser's receive
// time treats network + event-loop delay as if it were real playback time,
// which makes the clock hover ahead/behind the backend depending on latency.
//
// The server includes two timestamps in each state payload:
//   - sampledAtMs: when the backend observed currentTime
//   - serverNowMs: when the payload was emitted
//
// The browser observes serverNowMs at its own Date.now(), deriving a
// server->client wall-clock offset. sampledAtMs can then be converted into
// the browser's time domain before feeding playheadClock.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.createServerClock = factory().createServerClock;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function createServerClock() {
    let offsetMs = 0;
    let observed = false;
    let bestRttMs = Infinity;

    function observe(serverNowMs, clientNowMs) {
      if (!Number.isFinite(serverNowMs) || !Number.isFinite(clientNowMs)) return offsetMs;
      offsetMs = clientNowMs - serverNowMs;
      observed = true;
      return offsetMs;
    }

    // NTP-style offset estimate from one request/response:
    //   t0 = client send
    //   t1 = server receive
    //   t2 = server send
    //   t3 = client receive
    // offset(client - server) ~= ((t0 - t1) + (t3 - t2)) / 2
    // We keep the sample with the lowest RTT seen so far, since queueing/
    // scheduling asymmetry inflates RTT but can't make it smaller.
    function observeSync({ clientSendMs, serverReceiveMs, serverSendMs, clientReceiveMs }) {
      if (
        !Number.isFinite(clientSendMs) ||
        !Number.isFinite(serverReceiveMs) ||
        !Number.isFinite(serverSendMs) ||
        !Number.isFinite(clientReceiveMs)
      ) {
        return { offsetMs, rttMs: bestRttMs };
      }

      const rttMs = clientReceiveMs - clientSendMs - (serverSendMs - serverReceiveMs);
      const nextOffsetMs = ((clientSendMs - serverReceiveMs) + (clientReceiveMs - serverSendMs)) / 2;

      if (!observed || rttMs <= bestRttMs) {
        offsetMs = nextOffsetMs;
        bestRttMs = rttMs;
        observed = true;
      }

      return { offsetMs, rttMs };
    }

    function toClientMs(serverMs) {
      if (!Number.isFinite(serverMs)) return null;
      return observed ? serverMs + offsetMs : serverMs;
    }

    function getOffsetMs() {
      return offsetMs;
    }

    function hasObservation() {
      return observed;
    }

    return { observe, observeSync, toClientMs, getOffsetMs, hasObservation };
  }

  return { createServerClock };
}));
