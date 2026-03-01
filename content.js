/**
 * Steam Heatmap Tracker — Content Script
 *
 * Tracking logic:
 *  - CURSOR DWELL: every 200ms, if cursor hasn't moved >8px, record a "dwell point"
 *    weighted by dwell duration at the absolute page position.
 *  - SCROLL STOP: after scrolling, a 600ms debounce fires and records a point
 *    at the current cursor position (or viewport center if cursor is unknown).
 *
 * Storage: chrome.storage.local keyed by page URL (pathname).
 * Points are stored as absolute page coordinates (px), scroll-position-aware.
 * Heatmap: full-page canvas overlay drawn with radial gradients → colormap lookup.
 */

(function () {
  'use strict';

  /* ─── Config ──────────────────────────────────────────────────── */
  const DWELL_INTERVAL_MS    = 200;   // poll interval
  const DWELL_MOVE_THRESHOLD = 8;     // px — if cursor moved less than this, record dwell
  const SCROLL_DEBOUNCE_MS   = 600;   // ms after last scroll event to record a scroll-stop point
  const POINT_RADIUS         = 90;    // heatmap blob radius in px
  const MAX_POINTS           = 4000;  // cap per URL to avoid storage bloat
  const RENDER_THROTTLE_MS   = 1000;  // min ms between live re-renders while heatmap is visible

  /* ─── State ───────────────────────────────────────────────────── */
  let cursorX = -1, cursorY = -1;
  let lastRecordedX = -1, lastRecordedY = -1;
  let isTracking = false;
  let isHeatmapVisible = false;
  let heatmapCanvas = null;
  let scrollTimer = null;
  let dwellTimer = null;
  let renderScheduled = false;
  let points = [];          // { x, y, w } — x/y are absolute page px, w = weight
  const storageKey = 'heatmap_' + location.pathname.replace(/\//g, '_');

  /* ─── Load saved points ───────────────────────────────────────── */
  chrome.storage.local.get([storageKey], (result) => {
    points = result[storageKey] || [];
    startTracking();
  });

  /* ─── Tracking ────────────────────────────────────────────────── */
  function startTracking() {
    if (isTracking) return;
    isTracking = true;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('scroll', onScroll, { passive: true });
    dwellTimer = setInterval(checkDwell, DWELL_INTERVAL_MS);
  }

  function stopTracking() {
    isTracking = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('scroll', onScroll);
    clearInterval(dwellTimer);
    clearTimeout(scrollTimer);
  }

  function onMouseMove(e) {
    cursorX = e.clientX;
    cursorY = e.clientY;
  }

  function onScroll() {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (cursorX >= 0 && cursorY >= 0) {
        addPoint(cursorX, cursorY, 3); // scroll-stop = heavier weight
      } else {
        // fallback: viewport center
        addPoint(window.innerWidth / 2, window.innerHeight / 2, 2);
      }
    }, SCROLL_DEBOUNCE_MS);
  }

  function checkDwell() {
    if (cursorX < 0) return;
    const dx = cursorX - lastRecordedX;
    const dy = cursorY - lastRecordedY;
    if (Math.sqrt(dx * dx + dy * dy) < DWELL_MOVE_THRESHOLD) {
      addPoint(cursorX, cursorY, 1); // dwell = lighter weight
    }
    lastRecordedX = cursorX;
    lastRecordedY = cursorY;
  }

  function addPoint(clientX, clientY, weight) {
    if (points.length >= MAX_POINTS) points.shift(); // rolling window
    // Store as absolute page coordinates — viewport position + current scroll offset
    points.push({
      x: clientX + window.scrollX,
      y: clientY + window.scrollY,
      w: weight
    });
    if (points.length % 30 === 0) savePoints();
    if (isHeatmapVisible) scheduleRender();
  }

  /**
   * Throttle live re-renders to at most once per RENDER_THROTTLE_MS.
   * showHeatmap() still renders immediately on demand.
   */
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    setTimeout(() => {
      renderScheduled = false;
      if (isHeatmapVisible) renderHeatmap();
    }, RENDER_THROTTLE_MS);
  }

  function savePoints() {
    chrome.storage.local.set({ [storageKey]: points });
  }

  /* ─── Heatmap rendering ───────────────────────────────────────── */
  function createCanvas() {
    heatmapCanvas = document.createElement('canvas');
    heatmapCanvas.id = '__steam_heatmap_overlay__';
    Object.assign(heatmapCanvas.style, {
      position:      'absolute',
      top:           '0',
      left:          '0',
      zIndex:        '2147483647',
      pointerEvents: 'none',
      opacity:       '0.95',
      mixBlendMode:  'normal',
    });
    document.body.appendChild(heatmapCanvas);
  }

  /**
   * Two-pass rendering:
   * Pass 1 — draw radial alpha blobs on a greyscale canvas (full page dimensions)
   * Pass 2 — remap alpha values through a fire colormap
   */
  function renderHeatmap() {
    if (!heatmapCanvas) return;

    // Size canvas to cover the full page, not just the viewport
    const W = Math.max(document.documentElement.scrollWidth, window.innerWidth);
    const H = Math.max(document.documentElement.scrollHeight, window.innerHeight);
    heatmapCanvas.width        = W;
    heatmapCanvas.height       = H;
    heatmapCanvas.style.width  = W + 'px';
    heatmapCanvas.style.height = H + 'px';

    const ctx = heatmapCanvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    if (points.length === 0) return;

    /* ── Pass 1: alpha intensity map ─────────────────────────── */
    const alphaCanvas = document.createElement('canvas');
    alphaCanvas.width  = W;
    alphaCanvas.height = H;
    const ac = alphaCanvas.getContext('2d');
    ac.globalCompositeOperation = 'source-over';

    for (const p of points) {
      // Points are absolute page px — use directly, no conversion needed
      const r    = POINT_RADIUS * (p.w / 2 + 0.5); // weight scales radius slightly
      const grad = ac.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      grad.addColorStop(0,   `rgba(255,255,255,${Math.min(0.55 * p.w, 1.0)})`);
      grad.addColorStop(0.4, `rgba(255,255,255,${Math.min(0.28 * p.w, 0.7)})`);
      grad.addColorStop(1,   'rgba(255,255,255,0)');
      ac.fillStyle = grad;
      ac.beginPath();
      ac.arc(p.x, p.y, r, 0, Math.PI * 2);
      ac.fill();
    }

    /* ── Pass 2: colormap (cool → fire) ──────────────────────── */
    const alphaImageData = ac.getImageData(0, 0, W, H);
    const colorImageData = ctx.createImageData(W, H);
    const src = alphaImageData.data;
    const dst = colorImageData.data;

    for (let i = 0; i < src.length; i += 4) {
      const intensity = src[i + 3] / 255; // use alpha channel as intensity
      if (intensity === 0) continue;
      const [r, g, b] = colormapFire(intensity);
      dst[i]     = r;
      dst[i + 1] = g;
      dst[i + 2] = b;
      dst[i + 3] = Math.round(intensity * 255); // final alpha
    }
    ctx.putImageData(colorImageData, 0, 0);
  }

  /**
   * Fire colormap: black → blue → cyan → green → yellow → red
   * t in [0..1]
   */
  function colormapFire(t) {
    const stops = [
      [0.00,   0,   0, 128],
      [0.15,   0,   0, 255],
      [0.30,   0, 220, 255],
      [0.50,   0, 255,   0],
      [0.68, 255, 255,   0],
      [0.85, 255,  80,   0],
      [1.00, 255,   0,   0],
    ];
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const prev = stops[i - 1];
        const curr = stops[i];
        const f = (t - prev[0]) / (curr[0] - prev[0]);
        return [
          Math.round(prev[1] + f * (curr[1] - prev[1])),
          Math.round(prev[2] + f * (curr[2] - prev[2])),
          Math.round(prev[3] + f * (curr[3] - prev[3])),
        ];
      }
    }
    return [255, 0, 0];
  }

  /* ─── Show / Hide ─────────────────────────────────────────────── */
  function showHeatmap() {
    if (!heatmapCanvas) createCanvas();
    isHeatmapVisible = true;
    heatmapCanvas.style.display = 'block';
    renderHeatmap();
  }

  function hideHeatmap() {
    isHeatmapVisible = false;
    if (heatmapCanvas) heatmapCanvas.style.display = 'none';
  }

  /* ─── Message bridge (popup ↔ content script) ─────────────────── */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.action) {
      case 'show_heatmap':
        showHeatmap();
        sendResponse({ ok: true, points: points.length });
        break;
      case 'hide_heatmap':
        hideHeatmap();
        sendResponse({ ok: true });
        break;
      case 'clear_data':
        points = [];
        chrome.storage.local.remove(storageKey);
        hideHeatmap();
        sendResponse({ ok: true });
        break;
      case 'get_status':
        sendResponse({
          isTracking,
          isVisible: isHeatmapVisible,
          pointCount: points.length,
          storageKey
        });
        break;
      case 'toggle_tracking':
        if (isTracking) { stopTracking(); } else { startTracking(); }
        sendResponse({ isTracking });
        break;
      case 'export_data':
        sendResponse({ points, storageKey });
        break;
    }
    return true; // keep channel open for async
  });

  /* ─── Resize handler ──────────────────────────────────────────── */
  window.addEventListener('resize', () => {
    if (isHeatmapVisible) renderHeatmap();
  });

  /* ─── Save on unload ──────────────────────────────────────────── */
  window.addEventListener('beforeunload', savePoints);

})();
