'use strict';

const os = require('os');

/**
 * Every non-internal IPv4 address this machine currently has on a LAN
 * interface. Used as the address list shown on the Connect page, with a
 * QR code per address, for other devices on the show LAN to reach this one.
 */
function getLocalIPv4Addresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        addrs.push({ iface: name, address: net.address });
      }
    }
  }
  return addrs;
}

module.exports = { getLocalIPv4Addresses };
