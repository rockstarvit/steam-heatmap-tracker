/* popup.js — controls the extension popup */

let currentTab = null;
let isSteamPage = false;
let heatmapVisible = false;
let trackingActive = false;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isSteam(url) {
  return url && url.includes('steampowered.com');
}

async function sendMsg(action, payload = {}) {
  try {
    return await chrome.tabs.sendMessage(currentTab.id, { action, ...payload });
  } catch (e) {
    return null;
  }
}

function updateUI(status) {
  const trackDot   = document.getElementById('track-dot');
  const trackLabel = document.getElementById('track-label');
  const pointCount = document.getElementById('point-count');
  const btnHeatmap = document.getElementById('btn-heatmap');
  const btnTrack   = document.getElementById('btn-track');

  trackingActive  = status?.isTracking ?? false;
  heatmapVisible  = status?.isVisible  ?? false;
  const pts       = status?.pointCount ?? 0;

  trackDot.className  = 'dot' + (trackingActive ? ' active' : '');
  trackLabel.textContent = trackingActive ? 'Tracking active' : 'Tracking paused';
  pointCount.textContent = pts.toLocaleString() + ' pts';

  if (heatmapVisible) {
    btnHeatmap.innerHTML = '<span>🙈</span> Hide Heatmap';
    btnHeatmap.classList.add('active');
  } else {
    btnHeatmap.innerHTML = '<span>👁</span> Show Heatmap';
    btnHeatmap.classList.remove('active');
  }

  btnTrack.innerHTML = trackingActive
    ? '<span>⏸</span> Pause Tracking'
    : '<span>▶</span> Resume Tracking';
}

async function init() {
  currentTab = await getActiveTab();
  isSteamPage = isSteam(currentTab?.url);

  const mainContent = document.getElementById('main-content');
  const notSteam    = document.getElementById('not-steam-msg');
  const pageUrl     = document.getElementById('page-url');

  if (!isSteamPage) {
    mainContent.style.display = 'none';
    notSteam.style.display    = 'block';
    return;
  }

  pageUrl.textContent = currentTab.url.replace('https://store.steampowered.com', '…steam');

  const status = await sendMsg('get_status');
  updateUI(status);

  // ── Button handlers ──────────────────────────────────────────────

  document.getElementById('btn-heatmap').addEventListener('click', async () => {
    const action = heatmapVisible ? 'hide_heatmap' : 'show_heatmap';
    const res = await sendMsg(action);
    heatmapVisible = !heatmapVisible;
    const status = await sendMsg('get_status');
    updateUI(status);
  });

  document.getElementById('btn-track').addEventListener('click', async () => {
    await sendMsg('toggle_tracking');
    const status = await sendMsg('get_status');
    updateUI(status);
  });

  document.getElementById('btn-clear').addEventListener('click', async () => {
    if (!confirm('Clear all heatmap data for this page?')) return;
    await sendMsg('clear_data');
    updateUI({ isTracking: true, isVisible: false, pointCount: 0 });
  });

  document.getElementById('btn-export').addEventListener('click', async () => {
    const res = await sendMsg('export_data');
    if (!res) return;
    const json = JSON.stringify({ url: currentTab.url, points: res.points }, null, 2);
    await navigator.clipboard.writeText(json);
    const btn = document.getElementById('btn-export');
    btn.innerHTML = '<span>✅</span> Copied!';
    setTimeout(() => { btn.innerHTML = '<span>📋</span> Copy Data (JSON)'; }, 2000);
  });

  // ── Auto-refresh point count every 3s ───────────────────────────
  setInterval(async () => {
    const status = await sendMsg('get_status');
    if (status) {
      document.getElementById('point-count').textContent =
        (status.pointCount || 0).toLocaleString() + ' pts';
    }
  }, 3000);
}

init();
