(function () {
  'use strict';

  const socket = io();

  const DEFAULT_STANDBY_THRESHOLD_S = 30;
  const DEFAULT_IMMINENT_THRESHOLD_S = 10;
  const PREFERS_REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Mirrors PREVIEW_ID in src/backends/vmix.js -- the one backend-specific
  // id the generic UI recognizes, purely to show its "PREVIEW" label.
  const VMIX_PREVIEW_ID = 'vmix-preview';

  // ---- DOM refs -----------------------------------------------------
  const timePrimaryEl = document.getElementById('time-primary');
  const timeSecondaryEl = document.getElementById('time-secondary');
  const transportIconEl = document.getElementById('transport-icon');
  const timeSwapBtn = document.getElementById('time-swap-btn');
  const bannerEl = document.getElementById('disconnect-banner');
  const bannerTextEl = document.getElementById('disconnect-banner-text');
  const timelineEl = document.getElementById('timeline');
  const flagsRowEl = document.getElementById('flags-row');
  const rulerEl = document.getElementById('ruler');
  const playheadEl = document.getElementById('playhead');
  const filtersEl = document.getElementById('dept-filters');
  const refreshBtn = document.getElementById('refresh-btn');
  const orderListEl = document.getElementById('order-list');
  const popoverEl = document.getElementById('marker-popover');
  const popoverBodyEl = document.getElementById('popover-body');
  const popoverCloseEl = document.getElementById('popover-close');

  const settingsBtn = document.getElementById('settings-btn');
  const drawerEl = document.getElementById('settings-drawer');
  const overlayEl = document.getElementById('settings-overlay');
  const drawerCloseEl = document.getElementById('drawer-close');
  const deptEditorEl = document.getElementById('dept-editor');
  const deptAddBtn = document.getElementById('dept-add');
  const settingsSaveBtn = document.getElementById('settings-save');
  const settingsStatusEl = document.getElementById('settings-status');
  const cfgBackendType = document.getElementById('cfg-backend-type');
  const connectUrlsEl = document.getElementById('connect-urls');
  const cfgSectionQlab = document.getElementById('cfg-section-qlab');
  const cfgSectionVmix = document.getElementById('cfg-section-vmix');
  const cfgSectionThresholds = document.getElementById('cfg-section-thresholds');
  const cfgSectionDepartments = document.getElementById('cfg-section-departments');
  const cfgQlabHost = document.getElementById('cfg-qlab-host');
  const cfgQlabPort = document.getElementById('cfg-qlab-port');
  const cfgQlabPasscode = document.getElementById('cfg-qlab-passcode');
  const cfgVmixHost = document.getElementById('cfg-vmix-host');
  const cfgVmixPort = document.getElementById('cfg-vmix-port');
  const cfgStandbyThreshold = document.getElementById('cfg-standby-threshold');
  const cfgImminentThreshold = document.getElementById('cfg-imminent-threshold');
  const timelineListEl = document.getElementById('timeline-list');
  const backToLiveBtn = document.getElementById('back-to-live-btn');
  const orderPanelEl = document.getElementById('order-panel');

  const urlParams = new URLSearchParams(window.location.search);
  let activeDept = (urlParams.get('dept') || 'ALL').toUpperCase();

  let latestState = null;
  let latestSettings = {
    server: {},
    backend: { type: 'qlab' },
    departments: [],
    qlab: {},
    vmix: {},
    capabilities: { markers: true, departments: true }
  };
  let deptDraft = [];
  let lastImminentId = null;
  let lastScrolledActiveId = null;
  let primaryMode = 'elapsed'; // 'elapsed' | 'remaining' -- which readout is big

  // ---- multi-timeline selection ------------------------------------------
  // activeTimelineId = whichever timeline the SERVER says is live (from
  // QLab's isRunning/isPaused). selectedTimelineId = whichever timeline
  // THIS BROWSER is currently displaying. followLive keeps them in sync by
  // default; clicking a different timeline in the list turns it off so an
  // operator can preview e.g. the next track's notes without losing track
  // of what's actually live -- "Back to live" turns it back on.
  let activeTimelineId = null;
  let selectedTimelineId = null;
  let followLive = true;

  function selectedTimeline() {
    if (!latestState || !latestState.timelines) return null;
    return latestState.timelines.find((t) => t.id === selectedTimelineId) || null;
  }

  // QLab's full built-in cue color palette. A marker always renders in
  // its actual QLab color when the operator has set one; FALLBACK_COLOR
  // covers cues with no color ("none"). Color is never chosen here.
  const QLAB_COLOR_SWATCHES = {
    berry: '#8e3b5e', blue: '#4a90d9', crimson: '#b6293f', cyan: '#37c6c0',
    forest: '#2f6b3a', gray: '#8a8a8a', green: '#55b34d', 'hot pink': '#ff5fae',
    indigo: '#4b3f9e', lavender: '#b39ddb', magenta: '#c2318f', midnight: '#5a6ea8',
    olive: '#8a8a3e', orange: '#e08a2e', peach: '#f2a679', plum: '#8e4585',
    purple: '#8659c9', red: '#d8443c', 'sky blue': '#6ec6e8', yellow: '#e0c341'
  };
  const FALLBACK_COLOR = '#948d7d';

  // ---- formatting -----------------------------------------------------
  function fmtTime(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  }

  function fmtShort(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `${mm}:${String(ss).padStart(2, '0')}`;
  }

  function fmtCountdown(deltaSeconds) {
    const s = Math.max(0, Math.floor(deltaSeconds));
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `-${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  // ---- color lookup -------------------------------------
  function markerColor(marker) {
    return QLAB_COLOR_SWATCHES[(marker.color || '').toLowerCase()] || FALLBACK_COLOR;
  }

  // Backends without cue/marker detail (e.g. vMix) drive the track strip,
  // clock, and playhead only -- department filters, marker flags, and the
  // running-order table have nothing to show and are hidden entirely.
  function hasMarkers() {
    return !!(latestSettings.capabilities && latestSettings.capabilities.markers);
  }

  function standbyThresholdS() {
    const v = latestSettings.qlab.standbyThresholdS;
    return Number.isFinite(v) ? v : DEFAULT_STANDBY_THRESHOLD_S;
  }

  function imminentThresholdS() {
    const v = latestSettings.qlab.imminentThresholdS;
    return Number.isFinite(v) ? v : DEFAULT_IMMINENT_THRESHOLD_S;
  }

  function deptLabel(key) {
    const dept = latestSettings.departments.find((d) => d.key === key);
    return dept ? dept.label : key;
  }

  function filteredMarkers() {
    const tl = selectedTimeline();
    if (!tl) return [];
    if (activeDept === 'ALL') return tl.markers;
    return tl.markers.filter((m) => m.department === activeDept);
  }

  // Smoothed interpolation between server samples (see playheadClock.js).
  // Replaces the old "base = last currentTime + wall elapsed, reset every
  // sample" which glitched backward whenever a sample arrived with more
  // latency than the last one.
  const playheadClock = createPlayheadClock();
  const serverClock = createServerClock();
  let clockTimelineId = null;
  let clockSampleSeq = -Infinity;
  let syncTimer = null;

  function requestTimeSync() {
    const clientSendMs = Date.now();
    socket.emit('timeSync', { clientSendMs }, (payload) => {
      serverClock.observeSync({
        clientSendMs,
        serverReceiveMs: payload && payload.serverReceiveMs,
        serverSendMs: payload && payload.serverSendMs,
        clientReceiveMs: Date.now()
      });
    });
  }

  socket.on('connect', () => {
    requestTimeSync();
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(requestTimeSync, 5000);
  });

  socket.on('disconnect', () => {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
  });

  function sampleWallTime(tl, fallbackWallNow) {
    if (tl && Number.isFinite(tl.sampledAtMs)) {
      return serverClock.toClientMs(tl.sampledAtMs) || fallbackWallNow;
    }
    return fallbackWallNow;
  }

  // Feed the clock one server sample. Called once per received state, after
  // the selected timeline is resolved -- NOT per frame.
  function feedPlayheadClock() {
    const tl = selectedTimeline();
    const receivedAt = Date.now();
    // Coarse fallback until the first explicit time-sync round trip lands.
    if (!serverClock.hasObservation() && latestState && Number.isFinite(latestState.serverNowMs)) {
      serverClock.observe(latestState.serverNowMs, receivedAt);
    }
    if (!tl) {
      clockTimelineId = null;
      clockSampleSeq = -Infinity;
      return;
    }
    const wallNow = sampleWallTime(tl, receivedAt);
    if (tl.id !== clockTimelineId) {
      // Switched which timeline we're showing (followed live moved, or the
      // operator previewed another one) -- re-anchor rather than carry the
      // old one's clock across.
      clockTimelineId = tl.id;
      clockSampleSeq = Number.isFinite(tl.sampleSeq) ? tl.sampleSeq : -Infinity;
      if (tl.isPlaying) playheadClock.reset(tl.currentTime, wallNow);
      else playheadClock.hold(tl.currentTime);
      return;
    }
    if (Number.isFinite(tl.sampleSeq) && tl.sampleSeq <= clockSampleSeq) return;
    if (Number.isFinite(tl.sampleSeq)) clockSampleSeq = tl.sampleSeq;
    if (tl.isPlaying) playheadClock.sample(tl.currentTime, wallNow);
    else playheadClock.hold(tl.currentTime);
  }

  function currentEstimatedTime() {
    const tl = selectedTimeline();
    if (!tl) return 0;
    // Selection can change between server states (operator clicks a preview);
    // re-anchor the clock on the frame we first see the new timeline so the
    // estimate belongs to it, not the previously shown one.
    if (tl.id !== clockTimelineId) {
      clockTimelineId = tl.id;
      clockSampleSeq = Number.isFinite(tl.sampleSeq) ? tl.sampleSeq : -Infinity;
      const wallNow = sampleWallTime(tl, Date.now());
      if (tl.isPlaying) playheadClock.reset(tl.currentTime, wallNow);
      else playheadClock.hold(tl.currentTime);
    }
    // Only interpolate while the SELECTED timeline is itself actually
    // playing -- a preview of an upcoming/done timeline has a static
    // currentTime (0, or wherever it stopped), nothing to extrapolate.
    // Deliberately not gated on activeTimelineId: on vMix a track can be
    // isRunning without being the Program/"active" input (multiple
    // channels can play at once, unlike QLab's single active timeline),
    // so that comparison silently froze the playhead for anything
    // actually playing off-Program.
    if (!tl.isPlaying) return tl.currentTime;
    return playheadClock.estimate(Date.now());
  }

  // ---- filter chips -----------------------------------------------------
  function buildFilters() {
    filtersEl.innerHTML = '';
    // Backend has no marker/department concept at all (e.g. vMix) -- never
    // show filter chips, not even an empty row.
    if (!hasMarkers()) return;
    // Nothing to filter on a track (no marker cues) or before any timeline
    // is selected -- hide the department chips instead of showing filters
    // that can never match anything.
    const tl = selectedTimeline();
    if (!tl || tl.markers.length === 0) return;

    const depts = ['ALL', ...latestSettings.departments.map((d) => d.key)];
    depts.forEach((dept) => {
      const btn = document.createElement('button');
      btn.textContent = dept === 'ALL' ? 'ALL' : deptLabel(dept);
      btn.className = 'filter-chip' + (dept === activeDept ? ' active' : '');
      btn.addEventListener('click', () => {
        activeDept = dept;
        const url = new URL(window.location.href);
        if (dept === 'ALL') url.searchParams.delete('dept');
        else url.searchParams.set('dept', dept);
        window.history.replaceState({}, '', url);
        render();
      });
      filtersEl.appendChild(btn);
    });
  }

  // ---- timeline list: one row per discovered Timeline Group -------------
  // Same id-keyed-Map DOM-reuse pattern as the running-order table
  // (orderRowsById) -- avoids rebuilding rows (and re-triggering hover
  // transitions) every broadcast.
  const timelineRowsById = new Map();

  function selectTimelineId(id, { follow }) {
    followLive = follow;
    selectedTimelineId = id;
    const tl = latestState && latestState.timelines && latestState.timelines.find((t) => t.id === id);
    if (tl && !tl.markersLoaded) socket.emit('selectTimeline', id);
    render();
  }

  function renderTimelineList() {
    if (!timelineListEl) return;
    const timelines = (latestState && latestState.timelines) || [];

    backToLiveBtn.classList.toggle('hidden', followLive || !activeTimelineId);

    if (timelines.length === 0) {
      timelineListEl.innerHTML = '<p class="hint">No tracks found yet.</p>';
      timelineRowsById.clear();
      return;
    }

    // Clear a leftover "no timelines" message (or anything else stray) --
    // only tracked row elements should remain once we have real timelines.
    if (timelineRowsById.size === 0) timelineListEl.innerHTML = '';

    // A badge only ever appears on the timeline that's actually live/paused
    // and the one immediately after it in cue-list order -- everything
    // else (including already-finished tracks) is unmarked. Nothing is
    // playing at all -> no badges anywhere.
    const activeIdx = timelines.findIndex((t) => t.id === activeTimelineId);

    const seenIds = new Set();
    timelines.forEach((t, idx) => {
      seenIds.add(t.id);
      let entry = timelineRowsById.get(t.id);
      if (!entry) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'timeline-row';
        row.innerHTML = `
          <span class="timeline-row-top">
            <span class="timeline-row-status"></span>
            <span class="timeline-row-name"></span>
          </span>
          <span class="timeline-row-duration"></span>`;
        entry = {
          row,
          statusEl: row.querySelector('.timeline-row-status'),
          nameEl: row.querySelector('.timeline-row-name'),
          durationEl: row.querySelector('.timeline-row-duration')
        };
        row.addEventListener('click', () => {
          selectTimelineId(t.id, { follow: t.id === activeTimelineId });
        });
        timelineRowsById.set(t.id, entry);
      }

      const { row, statusEl, nameEl, durationEl } = entry;
      const isLive = activeIdx >= 0 && idx === activeIdx && !t.isPaused;
      const isPausedActive = activeIdx >= 0 && idx === activeIdx && t.isPaused;
      // "Up next" only means something in a sequential cue list (QLab) --
      // a backend without markers has no such sequence (e.g. vMix's
      // Preview slot is a distinct role, not "whatever's after Program"),
      // so never badge it there.
      const isNext = hasMarkers() && activeIdx >= 0 && idx === activeIdx + 1;
      const isPreview = t.id === VMIX_PREVIEW_ID;

      row.classList.toggle('is-selected', t.id === selectedTimelineId);
      row.classList.toggle('is-live', isLive);
      row.classList.toggle('is-paused-active', isPausedActive);
      row.classList.toggle('is-next', isNext);
      row.classList.toggle('is-track', t.kind === 'track');
      // The live dot is a separate element (not text) so mobile's
      // text-indent trick -- which turns the whole status pill into a dot
      // -- can keep hiding it without doubling up on two dots at once.
      const statusKey = isLive ? 'live' : isPausedActive ? 'pause' : isNext ? 'next' : isPreview ? 'preview' : '';
      if (entry.statusKey !== statusKey) {
        entry.statusKey = statusKey;
        statusEl.innerHTML = isLive ? '<span class="status-live-dot"></span>LIVE'
          : isPausedActive ? 'PAUSE' : isNext ? 'UP NEXT' : isPreview ? 'PREVIEW' : '';
      }
      // Plain tracks (no marker cues, just a duration) get a small icon so
      // they read as intentionally note-less rather than a broken timeline.
      nameEl.innerHTML = t.kind === 'track'
        ? `<i class="fa-solid fa-music track-kind-icon" aria-hidden="true" title="No cue notes"></i>${escapeHtml(t.name)}`
        : escapeHtml(t.name);
      durationEl.textContent = fmtTime(t.duration || 0);

      if (timelineListEl.children[idx] !== row) {
        timelineListEl.insertBefore(row, timelineListEl.children[idx] || null);
      }
    });

    for (const [id, entry] of timelineRowsById) {
      if (!seenIds.has(id)) {
        entry.row.remove();
        timelineRowsById.delete(id);
      }
    }

    // Keep the live card centered in the horizontally-scrolling strip --
    // same "follow the live one" convention as the running-order table's
    // scrollIntoView, just inline instead of block since this list scrolls
    // sideways. Only fires on an actual change of which track is active
    // (a skip forward/back), not on every render, so it doesn't fight an
    // operator who's manually scrolled the strip to look at something else.
    if (activeTimelineId && activeTimelineId !== lastScrolledActiveId) {
      lastScrolledActiveId = activeTimelineId;
      const activeEntry = timelineRowsById.get(activeTimelineId);
      if (activeEntry) {
        activeEntry.row.scrollIntoView({
          inline: 'center',
          block: 'nearest',
          behavior: PREFERS_REDUCED_MOTION ? 'auto' : 'smooth'
        });
      }
    } else if (!activeTimelineId) {
      lastScrolledActiveId = null;
    }
  }

  if (backToLiveBtn) {
    backToLiveBtn.addEventListener('click', () => {
      if (activeTimelineId) selectTimelineId(activeTimelineId, { follow: true });
    });
  }

  // ---- timeline: flags + ruler -----------------------------------------
  function renderTimeline() {
    flagsRowEl.innerHTML = '';
    Array.from(timelineEl.querySelectorAll('.marker-tick')).forEach((el) => el.remove());
    // No cue/marker concept on this backend -- the track fill (time grid)
    // and playhead alone carry the timeline, nothing to flag.
    if (!hasMarkers()) return;

    const markers = filteredMarkers();
    const duration = (selectedTimeline() && selectedTimeline().duration) || 1;

    markers.forEach((m) => {
      const pct = Math.min(100, (m.time / duration) * 100);
      const color = markerColor(m);

      const tick = document.createElement('div');
      tick.className = 'marker-tick';
      tick.style.left = `${pct}%`;
      tick.style.setProperty('--dept-color', color);
      timelineEl.appendChild(tick);

      const flag = document.createElement('button');
      flag.className = 'cue-flag';
      flag.style.left = `${pct}%`;
      flag.style.setProperty('--dept-color', color);
      flag.title = `${deptLabel(m.department)} — ${m.title} (${fmtTime(m.time)})`;
      flag.setAttribute('aria-label', `${deptLabel(m.department)} — ${m.title}`);
      flag.addEventListener('click', (evt) => openPopover(m, evt.currentTarget));
      flagsRowEl.appendChild(flag);
    });
  }

  function niceStep(duration) {
    const candidates = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    for (const step of candidates) {
      if (duration / step <= 10) return step;
    }
    return 3600;
  }

  function renderRuler() {
    const duration = (selectedTimeline() && selectedTimeline().duration) || 1;
    const step = niceStep(duration);
    rulerEl.innerHTML = '';
    for (let t = 0; t <= duration; t += step) {
      const tick = document.createElement('span');
      tick.className = 'ruler-tick';
      tick.style.left = `${(t / duration) * 100}%`;
      tick.textContent = fmtShort(t);
      rulerEl.appendChild(tick);
    }
  }


  // ---- playhead + clock --------------------------------------------------
  function renderPlayhead() {
    const tl = selectedTimeline();
    const duration = (tl && tl.duration) || 1;
    const t = currentEstimatedTime();
    const pct = Math.min(100, Math.max(0, (t / duration) * 100));
    playheadEl.style.left = `${pct}%`;

    const isRunning = !!(tl && tl.isRunning);
    const isPaused = !!(tl && tl.isPaused);
    const isPlaying = !!(tl && tl.isPlaying);
    // The playhead only means something while the SELECTED timeline is
    // itself running/paused; previewing another one (upcoming/done) hides
    // it rather than showing a stale/meaningless position. Keyed off the
    // track's own flags, not whether it's the single globally "active"
    // one -- on vMix a track can be Running without being the Program
    // input, so that comparison used to hide/freeze the playhead for
    // anything genuinely playing off-Program.
    const isActive = isRunning || isPaused;
    playheadEl.classList.toggle('hidden', !isActive);

    const elapsedFloor = Math.floor(Math.max(0, t));
    const elapsedStr = fmtTime(elapsedFloor);
    const remainingStr = `-${fmtTime(Math.max(0, duration - elapsedFloor))}`;
    if (primaryMode === 'elapsed') {
      timePrimaryEl.textContent = elapsedStr;
      timeSecondaryEl.textContent = remainingStr;
    } else {
      timePrimaryEl.textContent = remainingStr;
      timeSecondaryEl.textContent = elapsedStr;
    }

    transportIconEl.classList.toggle('hidden', !isActive);
    transportIconEl.classList.toggle('fa-play', isPlaying);
    transportIconEl.classList.toggle('fa-pause', isActive && !isPlaying);
    transportIconEl.classList.toggle('is-playing', isPlaying);
    transportIconEl.classList.toggle('is-paused', isActive && !isPlaying);
  }

  timeSwapBtn.addEventListener('click', () => {
    primaryMode = primaryMode === 'elapsed' ? 'remaining' : 'elapsed';
    renderPlayhead();
  });

  // ---- Running order table: one scrolling body, past dimmed, next imminent in red --
  // Rows are created once per marker id and reused across renders (only text/
  // classes are patched). Rebuilding the DOM from scratch every ~200ms was
  // retriggering the CSS hover transition on whatever row sat under the mouse,
  // which looked like a flicker; reusing nodes keeps hover state stable.
  const orderRowsById = new Map();
  // The sorted markers currently rendered as rows, so updateOrderTimers()
  // (called every animation frame) can refresh their countdowns/status
  // without re-sorting or rebuilding anything.
  let orderMarkersCache = [];

  function renderOrderList() {
    if (orderPanelEl) orderPanelEl.classList.toggle('hidden', !hasMarkers());
    if (!hasMarkers()) return;

    const tl = selectedTimeline();
    const markers = filteredMarkers().slice().sort((a, b) => a.time - b.time);

    // A track has no marker cues at all (by design), and an unfiltered
    // Timeline Group could in principle have zero markers too -- either
    // way, show an explicit placeholder instead of a silently empty table
    // (which used to look identical to "still loading"/"broken"). Distinct
    // from a department filter narrowing an otherwise non-empty timeline
    // down to zero rows -- that gets its own message so it's not mistaken
    // for "no notes exist at all".
    if (markers.length === 0) {
      orderMarkersCache = [];
      for (const [id, entry] of orderRowsById) {
        entry.row.remove();
        orderRowsById.delete(id);
      }
      let msg;
      if (!tl) msg = 'No track selected.';
      else if (tl.markers.length === 0) {
        msg = tl.kind === 'track' ? 'Audio track — no cue notes.' : 'No cue notes on this timeline yet.';
      } else {
        msg = `No ${deptLabel(activeDept)} cues on this timeline.`;
      }
      orderListEl.innerHTML = `<tr class="order-empty-row"><td colspan="4"><p class="hint">${escapeHtml(msg)}</p></td></tr>`;
      return;
    }
    if (orderListEl.querySelector('.order-empty-row')) orderListEl.innerHTML = '';

    const seenIds = new Set();

    // Structure + static content only. Everything that depends on the
    // moving clock (countdown text, next/standby/imminent/passed classes)
    // is deliberately NOT set here -- it's refreshed every animation frame
    // by updateOrderTimers(), so the per-cue countdowns stay in lockstep
    // with the interpolated playhead instead of freezing between the
    // server's throttled state broadcasts and then jumping on arrival.
    markers.forEach((m, idx) => {
      seenIds.add(m.id);
      let entry = orderRowsById.get(m.id);
      if (!entry) {
        const row = document.createElement('tr');
        row.className = 'order-row';
        row.innerHTML = `
          <td class="col-time" data-label="Time"><span class="order-time"></span><span class="countdown"></span></td>
          <td class="col-dept" data-label="Department"><span class="dept-tag"></span></td>
          <td class="col-name" data-label="Name"></td>
          <td class="col-notes" data-label="Notes"></td>`;
        entry = {
          row,
          timeEl: row.querySelector('.order-time'),
          countdownEl: row.querySelector('.countdown'),
          deptEl: row.querySelector('.dept-tag'),
          nameEl: row.querySelector('.col-name'),
          notesEl: row.querySelector('.col-notes')
        };
        orderRowsById.set(m.id, entry);
      }

      const { row, timeEl, deptEl, nameEl, notesEl } = entry;

      timeEl.textContent = fmtTime(m.time);
      deptEl.textContent = deptLabel(m.department);
      deptEl.style.setProperty('--dept-color', markerColor(m));
      nameEl.textContent = m.title;

      const hasNotes = !!(m.notes && m.notes.trim());
      notesEl.classList.toggle('is-empty', !hasNotes);
      notesEl.innerHTML = hasNotes ? escapeHtml(m.notes) : '<span class="muted">—</span>';

      if (orderListEl.children[idx] !== row) {
        orderListEl.insertBefore(row, orderListEl.children[idx] || null);
      }
    });

    for (const [id, entry] of orderRowsById) {
      if (!seenIds.has(id)) {
        entry.row.remove();
        orderRowsById.delete(id);
      }
    }

    orderMarkersCache = markers;
    updateOrderTimers();
  }

  // Time-dependent half of the running order: countdown text and the
  // next/standby/imminent/passed status classes, recomputed off the same
  // interpolated clock (currentEstimatedTime) as the main playhead. Runs
  // every animation frame (tick()) so each row's countdown ticks over at
  // the same instant as the primary readout, cheap because it only patches
  // existing rows -- no sort, no DOM rebuild, no text/notes rewrites.
  function updateOrderTimers() {
    if (!hasMarkers() || orderMarkersCache.length === 0) return;
    const tl = selectedTimeline();
    const t = currentEstimatedTime();
    // Same floored base as the main clock's Math.floor(t) so every row's
    // countdown rolls over at the exact instant the primary readout does.
    const elapsedFloor = Math.floor(Math.max(0, t));
    // Green/amber/red only mean something while the show is actually
    // moving -- on a stopped track "next cue" isn't really pending.
    const isActive = !!(tl && (tl.isRunning || tl.isPaused));

    let nextMarker = null;
    for (const m of orderMarkersCache) {
      if (m.time > t) { nextMarker = m; break; }
    }

    for (const m of orderMarkersCache) {
      const entry = orderRowsById.get(m.id);
      if (!entry) continue;
      const { row, countdownEl } = entry;
      const isPassed = m.time <= t;
      const isNext = !isPassed && m === nextMarker;
      const timeToGo = m.time - t;
      const isImminent = isActive && isNext && timeToGo <= imminentThresholdS();
      const isStandby = isActive && isNext && !isImminent && timeToGo <= standbyThresholdS();
      const isUpcoming = isActive && isNext && !isImminent && !isStandby;
      row.classList.toggle('is-passed', isPassed);
      row.classList.toggle('is-imminent', isImminent);
      row.classList.toggle('is-standby', isStandby);
      row.classList.toggle('is-upcoming', isUpcoming);
      if (isNext) row.dataset.next = 'true';
      else delete row.dataset.next;
      countdownEl.textContent = isPassed ? '' : fmtCountdown(m.time - elapsedFloor);
    }

    if (nextMarker && nextMarker.id !== lastImminentId) {
      lastImminentId = nextMarker.id;
      const row = orderListEl.querySelector('[data-next="true"]');
      if (row) row.scrollIntoView({ block: 'center', behavior: PREFERS_REDUCED_MOTION ? 'auto' : 'smooth' });
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ---- marker detail popover ---------------------------------------------
  function openPopover(marker, anchorEl) {
    popoverBodyEl.innerHTML = `
      <div class="popover-dept" style="--dept-color:${markerColor(marker)}">${escapeHtml(deptLabel(marker.department))}</div>
      <h3>${escapeHtml(marker.title)}</h3>
      <dl>
        <dt>Cue number</dt><dd>${escapeHtml(marker.number || '—')}</dd>
        <dt>Type</dt><dd>${escapeHtml(marker.type || '—')}</dd>
        <dt>Position</dt><dd>${fmtTime(marker.time)}</dd>
        <dt>Notes</dt><dd>${escapeHtml(marker.notes) || '<span class="muted">None</span>'}</dd>
      </dl>`;
    popoverEl.classList.remove('hidden');

    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      const top = Math.min(window.innerHeight - 260, rect.bottom + 8);
      const left = Math.min(window.innerWidth - 320, Math.max(8, rect.left - 100));
      popoverEl.style.top = `${top}px`;
      popoverEl.style.left = `${left}px`;
    }
  }

  function closePopover() {
    popoverEl.classList.add('hidden');
  }

  popoverCloseEl.addEventListener('click', closePopover);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closePopover(); closeDrawer(); }
  });
  document.addEventListener('click', (e) => {
    if (!popoverEl.contains(e.target) && !e.target.classList.contains('cue-flag')) {
      closePopover();
    }
  });

  let bannerShowTimer = null;

  function backendLabel() {
    return latestSettings.backend.type === 'vmix' ? 'vMix' : 'QLab';
  }

  function renderBanner() {
    const connected = latestState && latestState.connectedToBackend !== false;
    if (bannerTextEl) bannerTextEl.textContent = `${backendLabel()} is offline — showing the last known state`;
    if (connected) {
      if (bannerShowTimer) { clearTimeout(bannerShowTimer); bannerShowTimer = null; }
      bannerEl.classList.add('hidden');
      return;
    }
    // Debounce: a page refresh briefly shows a stale/empty state before the
    // first socket payload confirms QLab is still connected -- don't flash
    // the banner for a disconnect that clears itself within a second.
    if (bannerShowTimer || !bannerEl.classList.contains('hidden')) return;
    bannerShowTimer = setTimeout(() => {
      bannerShowTimer = null;
      bannerEl.classList.remove('hidden');
    }, 800);
  }

  // ---- master render -------------------------------------------------------
  function render() {
    // A backend with no cue/marker concept (e.g. vMix) drops the whole
    // department-filter row and running-order section from layout, not
    // just their content -- see the body.no-markers rules in style.css.
    document.body.classList.toggle('no-markers', !hasMarkers());
    buildFilters();
    renderTimelineList();
    renderTimeline();
    renderRuler();
    renderPlayhead();
    renderOrderList();
    renderBanner();
  }

  socket.on('state', (payload) => {
    latestState = payload;
    activeTimelineId = payload.activeTimelineId || null;

    if (followLive && activeTimelineId) {
      // A timeline is live -- follow it.
      selectedTimelineId = activeTimelineId;
    } else if (!followLive && !payload.timelines.some((t) => t.id === selectedTimelineId)) {
      // Whatever we were previewing disappeared (rare, e.g. show reloaded) --
      // fall back to following live rather than showing nothing.
      followLive = true;
      selectedTimelineId = activeTimelineId;
    }
    // else: following live but nothing is live right now (e.g. the
    // operator just stopped a track) -- deliberately keep showing
    // whatever was selected before instead of jumping to another
    // timeline. Without this, the view used to blank/jump to the first
    // discovered (possibly marker-less) timeline the instant playback
    // stopped, until the next periodic refresh loaded it.

    // Nothing selected yet at all (first load, nothing live) -- default to
    // the first discovered timeline so the view isn't empty.
    if (!selectedTimelineId && payload.timelines.length > 0) {
      selectedTimelineId = payload.timelines[0].id;
    }

    feedPlayheadClock();
    render();
  });

  socket.on('settings', (payload) => {
    latestSettings = {
      server: payload.server || {},
      backend: payload.backend || { type: 'qlab' },
      departments: payload.departments || [],
      qlab: payload.qlab || {},
      vmix: payload.vmix || {},
      capabilities: payload.capabilities || { markers: true, departments: true }
    };
    render();
  });

  refreshBtn.addEventListener('click', () => socket.emit('refresh'));

  // Smooth local interpolation between server ticks: both the main
  // playhead/clock AND the per-cue countdowns run off currentEstimatedTime
  // every frame, so nothing time-based waits on the next state broadcast.
  function tick() {
    if (latestState) {
      renderPlayhead();
      updateOrderTimers();
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ---- Settings drawer -----------------------------------------------------
  // Shows/hides the QLab vs vMix connection fields and the marker-only
  // sections (thresholds, departments) to match whatever's selected in the
  // drawer right now -- NOT necessarily the backend actually running yet,
  // since the operator may be switching before saving.
  function updateDrawerSections() {
    const type = cfgBackendType.value;
    cfgSectionQlab.classList.toggle('hidden', type !== 'qlab');
    cfgSectionVmix.classList.toggle('hidden', type !== 'vmix');
    const markersCapable = type === 'qlab'; // only QLab has cue/marker detail today
    cfgSectionThresholds.classList.toggle('hidden', !markersCapable);
    cfgSectionDepartments.classList.toggle('hidden', !markersCapable);
  }

  function openDrawer() {
    deptDraft = latestSettings.departments.map((d) => ({ ...d }));
    cfgBackendType.value = latestSettings.backend.type || 'qlab';
    cfgQlabHost.value = latestSettings.qlab.host || '';
    cfgQlabPort.value = latestSettings.qlab.tcpPort || '';
    cfgQlabPasscode.value = latestSettings.qlab.passcode || '';
    cfgVmixHost.value = latestSettings.vmix.host || '';
    cfgVmixPort.value = latestSettings.vmix.tcpPort || '';
    cfgStandbyThreshold.value = standbyThresholdS();
    cfgImminentThreshold.value = imminentThresholdS();
    settingsStatusEl.textContent = '';
    settingsStatusEl.className = 'settings-status';
    renderDeptEditor();
    updateDrawerSections();
    loadConnectInfo();
    drawerEl.classList.remove('hidden');
    overlayEl.classList.remove('hidden');
  }

  function loadConnectInfo() {
    connectUrlsEl.textContent = '';
    fetch('/api/system')
      .then((r) => r.json())
      .then((info) => renderConnectInfo(info))
      .catch(() => {
        const empty = document.createElement('p');
        empty.className = 'connect-urls-empty';
        empty.textContent = 'Could not load connection info.';
        connectUrlsEl.appendChild(empty);
      });
  }

  function renderConnectInfo(info) {
    connectUrlsEl.textContent = '';
    const urls = (info && info.urls) || [];
    if (urls.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'connect-urls-empty';
      empty.textContent = 'No LAN address found yet.';
      connectUrlsEl.appendChild(empty);
      return;
    }
    for (const entry of urls) {
      const row = document.createElement('div');
      row.className = 'connect-url-entry';

      const img = document.createElement('img');
      img.src = entry.qr;
      img.alt = `QR code for ${entry.url}`;
      row.appendChild(img);

      const meta = document.createElement('div');
      meta.className = 'connect-url-meta';
      const label = document.createElement('span');
      label.className = 'connect-url-label';
      label.textContent = entry.label;
      const link = document.createElement('a');
      link.className = 'connect-url-link';
      link.href = entry.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = entry.url;
      meta.appendChild(label);
      meta.appendChild(link);
      row.appendChild(meta);

      connectUrlsEl.appendChild(row);
    }
  }

  function closeDrawer() {
    drawerEl.classList.add('hidden');
    overlayEl.classList.add('hidden');
  }

  settingsBtn.addEventListener('click', openDrawer);
  drawerCloseEl.addEventListener('click', closeDrawer);
  overlayEl.addEventListener('click', closeDrawer);
  cfgBackendType.addEventListener('change', updateDrawerSections);

  function renderDeptEditor() {
    deptEditorEl.innerHTML = '';
    deptDraft.forEach((dept, idx) => {
      const row = document.createElement('div');
      row.className = 'editor-row';
      row.innerHTML = `
        <input type="text" class="dept-key" value="${escapeHtml(dept.key)}" placeholder="LX" maxlength="12" />
        <input type="text" class="dept-label" value="${escapeHtml(dept.label)}" placeholder="Label" />
        <div class="editor-row-actions">
          <button type="button" class="icon-btn small" data-action="up" ${idx === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button type="button" class="icon-btn small" data-action="down" ${idx === deptDraft.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
          <button type="button" class="icon-btn small danger" data-action="remove" aria-label="Remove">×</button>
        </div>`;
      row.querySelector('.dept-key').addEventListener('input', (e) => { dept.key = e.target.value.toUpperCase(); });
      row.querySelector('.dept-label').addEventListener('input', (e) => { dept.label = e.target.value; });
      row.querySelector('[data-action="up"]').addEventListener('click', () => {
        if (idx === 0) return;
        [deptDraft[idx - 1], deptDraft[idx]] = [deptDraft[idx], deptDraft[idx - 1]];
        renderDeptEditor();
      });
      row.querySelector('[data-action="down"]').addEventListener('click', () => {
        if (idx === deptDraft.length - 1) return;
        [deptDraft[idx + 1], deptDraft[idx]] = [deptDraft[idx], deptDraft[idx + 1]];
        renderDeptEditor();
      });
      row.querySelector('[data-action="remove"]').addEventListener('click', () => {
        deptDraft.splice(idx, 1);
        renderDeptEditor();
      });
      deptEditorEl.appendChild(row);
    });
  }

  deptAddBtn.addEventListener('click', () => {
    deptDraft.push({ key: 'NEW', label: 'New department' });
    renderDeptEditor();
  });

  settingsSaveBtn.addEventListener('click', async () => {
    const patch = {
      backend: { type: cfgBackendType.value },
      qlab: {
        host: cfgQlabHost.value.trim(),
        tcpPort: Number(cfgQlabPort.value) || 53000,
        passcode: cfgQlabPasscode.value,
        standbyThresholdS: Number(cfgStandbyThreshold.value) || 0,
        imminentThresholdS: Number(cfgImminentThreshold.value) || 0
      },
      vmix: {
        host: cfgVmixHost.value.trim(),
        tcpPort: Number(cfgVmixPort.value) || 8099
      },
      departments: deptDraft.map((d) => ({ key: d.key.trim().toUpperCase(), label: d.label.trim() }))
    };

    settingsStatusEl.textContent = 'Saving…';
    settingsStatusEl.className = 'settings-status';
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not save settings');
      settingsStatusEl.textContent = 'Settings saved';
      settingsStatusEl.className = 'settings-status ok';
    } catch (err) {
      settingsStatusEl.textContent = err.message;
      settingsStatusEl.className = 'settings-status error';
    }
  });

  // ---- initial load ---------------------------------------------------------
  fetch('/api/settings')
    .then((r) => r.json())
    .then((cfg) => {
      latestSettings = {
        server: cfg.server || {},
        backend: cfg.backend || { type: 'qlab' },
        departments: cfg.departments || [],
        qlab: cfg.qlab || {},
        vmix: cfg.vmix || {},
        capabilities: cfg.capabilities || { markers: true, departments: true }
      };
      render();
    })
    .catch((err) => console.error('Failed to load /api/settings', err));
})();
