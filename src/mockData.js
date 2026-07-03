'use strict';

/**
 * Hand-authored mock timelines used to validate the full UI before a
 * backend is wired up, in USE_MOCK=1 mode (see src/backends/mock.js).
 * Three Timeline Groups exercise all three statuses: one already
 * finished, one currently live (mock.js advances its playhead), one not
 * started yet -- so clicking the not-yet-started one previews its
 * markers/notes even though a different one is still "playing". A
 * fourth entry (`kind: 'track'`) mocks a plain single-cue track loaded
 * alongside them -- QLab's own Group cues + single audio cues in the
 * same cue list -- with a duration but no marker cues, matching what
 * discoverTimelines() (src/backends/qlab.js) produces for a non-Group
 * top-level cue.
 *
 * Marker `time` is seconds from the start of that track's own Timeline
 * Group, mirroring what a real preWait-derived marker.time looks like.
 */
const MOCK_TIMELINES = [
  {
    id: 'mock-tl-1',
    name: 'Scene 1 - Apertura',
    number: '1',
    duration: 180,
    status: 'done',
    kind: 'timeline',
    markers: [
      { id: 'mock-1-1', number: '1.1', name: '[SONG] Ouverture', department: 'SONG', title: 'Ouverture', time: 0, type: 'Memo', color: 'green', notes: '' },
      { id: 'mock-1-2', number: '1.2', name: '[LX] Cue 1 - Buio sala', department: 'LX', title: 'Cue 1 - Buio sala', time: 8, type: 'Memo', color: 'yellow', notes: '' },
      { id: 'mock-1-3', number: '1.3', name: '[STAGE] Entrata cast', department: 'STAGE', title: 'Entrata cast', time: 140, type: 'Memo', color: 'red', notes: 'Aspettare buio completo prima di entrare' }
    ]
  },
  {
    id: 'mock-tl-2',
    name: 'Scene 2 - Il viaggio',
    number: '2',
    duration: 240,
    status: 'live',
    kind: 'timeline',
    markers: [
      { id: 'mock-2-1', number: '2.1', name: '[VIDEO] Fondale città', department: 'VIDEO', title: 'Fondale città', time: 0, type: 'Network', color: 'blue', notes: 'Invia OSC a Resolume' },
      { id: 'mock-2-2', number: '2.2', name: '[LX] Cue 2 - Controluce blu', department: 'LX', title: 'Cue 2 - Controluce blu', time: 45, type: 'Memo', color: 'yellow', notes: '' },
      { id: 'mock-2-3', number: '2.3', name: '[VIDEO] Cambio clip piazza', department: 'VIDEO', title: 'Cambio clip piazza', time: 90, type: 'Network', color: 'blue', notes: '' },
      { id: 'mock-2-4', number: '2.4', name: '[DIALOGO] Scena 1', department: 'DIALOGO', title: 'Scena 1', time: 160, type: 'Memo', color: 'purple', notes: 'Aspettare battuta finale' },
      { id: 'mock-2-5', number: '2.5', name: '[LX] Cue 3 - Interno casa', department: 'LX', title: 'Cue 3 - Interno casa', time: 210, type: 'Memo', color: 'yellow', notes: '' }
    ]
  },
  {
    id: 'mock-tl-3',
    name: 'Scene 3 - Finale',
    number: '3',
    duration: 300,
    status: 'upcoming',
    kind: 'timeline',
    markers: [
      { id: 'mock-3-1', number: '3.1', name: '[SONG] Inizio brano finale', department: 'SONG', title: 'Inizio brano finale', time: 0, type: 'Memo', color: 'green', notes: '' },
      { id: 'mock-3-2', number: '3.2', name: '[STAGE] Cambio quinta', department: 'STAGE', title: 'Cambio quinta', time: 70, type: 'Memo', color: 'red', notes: 'Macchinista: liberare passaggio SX prima del blackout' },
      { id: 'mock-3-3', number: '3.3', name: '[LX] Cue 4 - Full stage', department: 'LX', title: 'Cue 4 - Full stage', time: 260, type: 'Memo', color: 'yellow', notes: '' }
    ]
  },
  {
    id: 'mock-track-1',
    name: 'Musica ingresso pubblico',
    number: '4',
    duration: 95,
    status: 'upcoming',
    kind: 'track',
    markers: []
  }
];

module.exports = { MOCK_TIMELINES };
