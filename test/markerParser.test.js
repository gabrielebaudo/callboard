'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMarkerName, resolveDepartment } = require('../src/markerParser');

test('parseMarkerName: standard prefix', () => {
  assert.deepEqual(parseMarkerName('[LX] Cue 45 - Fade caldo 5s'), {
    department: 'LX',
    title: 'Cue 45 - Fade caldo 5s'
  });
});

test('parseMarkerName: lowercase prefix normalized to uppercase', () => {
  assert.deepEqual(parseMarkerName('[video] Fondale Bosco'), {
    department: 'VIDEO',
    title: 'Fondale Bosco'
  });
});

test('parseMarkerName: no prefix -> UNCATEGORIZED', () => {
  assert.deepEqual(parseMarkerName('Just a plain cue name'), {
    department: 'UNCATEGORIZED',
    title: 'Just a plain cue name'
  });
});

test('parseMarkerName: extra whitespace around brackets', () => {
  assert.deepEqual(parseMarkerName('   [ STAGE ]   Entrata cast  '), {
    department: 'STAGE',
    title: 'Entrata cast'
  });
});

test('parseMarkerName: empty title after prefix falls back to raw name', () => {
  assert.deepEqual(parseMarkerName('[LX]'), {
    department: 'LX',
    title: '[LX]'
  });
});

test('parseMarkerName: non-string input', () => {
  assert.deepEqual(parseMarkerName(undefined), {
    department: 'UNCATEGORIZED',
    title: ''
  });
});

const config = {
  departments: [
    { key: 'LX', label: 'Lighting', color: '#f6d365' },
    { key: 'VIDEO', label: 'Video', color: '#7db7ff' },
    { key: 'SONG', label: 'Songs', color: '#9be28f' },
    { key: 'DIALOGO', label: 'Dialogue', color: '#c6a0ff' },
    { key: 'STAGE', label: 'Stage', color: '#ff9f9f' }
  ]
};

test('resolveDepartment: recognized prefix is kept', () => {
  assert.deepEqual(resolveDepartment('[LX] Cue 1', config), {
    department: 'LX',
    title: 'Cue 1'
  });
});

test('resolveDepartment: prefix not in configured departments -> UNCATEGORIZED', () => {
  assert.deepEqual(resolveDepartment('[WEIRD] Something', config), {
    department: 'UNCATEGORIZED',
    title: 'Something'
  });
});

test('resolveDepartment: no prefix -> UNCATEGORIZED', () => {
  assert.deepEqual(resolveDepartment('Plain name', config), {
    department: 'UNCATEGORIZED',
    title: 'Plain name'
  });
});

test('resolveDepartment: without a departments config, any prefix is kept', () => {
  assert.deepEqual(resolveDepartment('[ANYTHING] Title', {}), {
    department: 'ANYTHING',
    title: 'Title'
  });
});
