import { GIFEncoder, quantize, applyPalette } from 'https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js';

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------
const MIN_SELECTION_S = 0.1;      // the stoppers can't get closer than this
// the stoppers can't get further apart than this either. a GIF this long is
// already a big, slow-to-render file, and for the YouTube path a smaller cap
// here means the fetch window (see ytFetchWindow) stays small on its own,
// well under the server's separate YT_MAX_SECTION_S limit
const MAX_GIF_LENGTH_S = 30;
const DEFAULT_SELECTION_S = 3;    // a fresh local video starts with its first 3 s picked
const DEFAULT_YT_SELECTION_S = 10; // a YouTube video starts with 10 s picked at the link's timestamp
const FRAME_STEP_S = 1 / 30;      // arrow-key nudge. a <video> won't tell us its real fps, 30 is the common case
const BIG_STEP_S = 1;             // shift + arrow
const MAX_FRAMES = 600;           // per GIF. past this the file size and the tab's memory both get silly
const PALETTE_SAMPLES = 12;       // frames that feed a shared palette
const MIN_DELAY_CS = 2;           // browsers clamp any GIF delay under 2cs up to 10cs, so 50fps is the ceiling
const SEEK_TIMEOUT_MS = 8000;     // per seek, before we give up on a stuck decoder
const LOAD_TIMEOUT_MS = 30000;    // to first decoded frame
const MAX_THUMBS = 40;            // filmstrip frames grabbed per video
const THUMB_PX = 96;              // filmstrip frame height in device pixels
const END_EPSILON_S = 0.001;      // seeking to exactly duration shows a blank frame in some browsers
const MIN_VIEW_S = 1;             // tightest the timeline zooms, in seconds across its full width
const ZOOM_WHEEL_RATE = 0.0015;   // zoom factor per wheel pixel, as exp(deltaY * rate)
const ZOOM_SEL_PAD = 0.15;        // "zoom to selection" leaves this fraction of the span either side
const MIN_TICK_GAP_PX = 90;       // CSS px between labelled ticks on a thumbnail-less timeline
const TICK_STEPS_S = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
const QUALITY_PRESETS = [
  { colours: 64, palette: 'global' },   // small
  { colours: 128, palette: 'global' },  // balanced
  { colours: 256, palette: 'frame' },   // best
];

// youtube. the section we fetch is padded either side of the selection so
// you've got room to fine-trim once it's local, and so a stopper you dropped
// a frame late on a 3 hour timeline doesn't clip the start of the play
const YT_PAD_S = 2;
const YT_API_URL = 'https://www.youtube.com/iframe_api';
const YT_HOST = 'https://www.youtube-nocookie.com'; // no tracking cookies until someone hits play
const YT_API_TIMEOUT_MS = 15000;
const YT_READY_TIMEOUT_MS = 20000;
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// delayCs (centiseconds per frame) is the source of truth for timing, because
// that's the unit a GIF stores. fps is only ever derived from it for display
const settings = {
  width: 480,         // 0 means the source's own width
  delayCs: 7,
  colours: 128,
  palette: 'global',  // 'global' shares one colour table, 'frame' builds one per frame
  speed: 1,
  repeat: 0,          // gifenc's loop field: 0 forever, -1 once, n for n extra plays
  boomerang: false,
};

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const video = el('video');
const timeline = el('timeline');

// two hidden decoders on the same blob. the grabber reads frames for the GIF
// and the thumber builds the filmstrip, so neither has to wait on the other or
// yank the visible player's playhead around
const grabber = makeHiddenVideo();
const thumber = makeHiddenVideo();

let mode = 'none';         // 'none', 'local' (a file we can read frames from) or 'youtube' (browse only)
let videoUrl = null;       // object URL shared by all three video elements
let videoName = 'clip';    // sanitised base name, used for the download
let timeOffset = 0;        // where this clip sat in its YouTube source, so filenames carry real times
let duration = 0;          // 0 means nothing is loaded
let selIn = 0;
let selOut = 0;
let viewStart = 0;         // the slice of the video the timeline is zoomed to
let viewEnd = 0;
let uiTime = 0;            // where the playhead is drawn, which runs ahead of a pending seek
let loopSelection = true;
let loadGeneration = 0;    // bumps on every load so stale async work knows to bail
let urlAbort = null;       // aborts an in-flight URL download when something newer loads
let exporting = false;
let cancelExport = false;
let resultUrl = null;
let resultName = '';
let yt = null;             // { id, title, player } while a YouTube video is on stage
let ytReturn = null;       // how to get back to the full YouTube video from a fetched clip
let ytFetchAbort = null;
let _ytApi = null;         // the iframe API load, shared by every open
let _ytConfig = null;      // what the server says it can do, fetched once
let _pendingSeek = null;   // latest seek asked for while the player was still busy seeking
let _raf = 0;
let _drag = null;          // { kind, pointerId, offset, span }
let _thumbs = [];          // { t, canvas } in time order
let _grabCanvas = null;
let _grabCtx = null;
let _statusTimer = 0;

function makeHiddenVideo() {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  return v;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pad2 = (n) => String(n).padStart(2, '0');

function fmtTime(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const cs = Math.round(t * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const tail = `${pad2(Math.floor((cs % 6000) / 100))}.${pad2(cs % 100)}`;
  return h ? `${h}:${pad2(m)}:${tail}` : `${m}:${tail}`;
}

// filenames can't carry colons, so 1:02:03.50 becomes 1h02m03.50s
function fmtFileTime(t) {
  const parts = fmtTime(t).split(':');
  return parts.length === 3 ? `${parts[0]}h${parts[1]}m${parts[2]}s` : `${parts[0]}m${parts[1]}s`;
}

// the inverse of fmtTime: turns whatever someone typed into the in/out boxes
// into seconds, or null if it doesn't look like a time at all. accepts a
// bare number of seconds too, since that's the easiest thing to type on a
// phone keyboard that hides the ":" behind a symbols page. anything with a
// minutes or hours field of 60+ is rejected rather than silently carried,
// since that's more likely a typo ("1:75") than someone meaning 2:15
function parseTimeInput(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const parts = s.split(':');
  if (parts.length > 3) return null;
  const nums = parts.map((p) => (p.trim() === '' ? NaN : Number(p)));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  for (let i = 1; i < nums.length; i++) if (nums[i] >= 60) return null;
  let t = 0;
  for (const n of nums) t = t * 60 + n;
  return t;
}

// tick labels drop the centiseconds once ticks are a second or more apart
function fmtTick(t, stepS) {
  if (stepS < 1) return fmtTime(t);
  const s = Math.round(t);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
}

function sanitiseName(name) {
  const base = String(name || '').replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '_').slice(0, 60);
  return base.replace(/^[_.]+|[_.]+$/g, '') || 'clip';
}

function status(msg, kind = 'ok', holdMs = 3200) {
  const s = el('status');
  s.textContent = msg;
  s.className = `show ${kind}`;
  clearTimeout(_statusTimer);
  // busy messages stay up until something replaces them
  if (kind !== 'busy') _statusTimer = setTimeout(() => s.classList.remove('show'), holdMs);
}

function downloadBlobUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------------------
// the media adapter. the dock talks to whatever's on stage through `media`,
// either the local <video> or a YouTube embed, so scrubbing, stoppers and
// looping behave the same for both. only the local one can hand frames to
// the GIF encoder
// ---------------------------------------------------------------------------
const localMedia = {
  kind: 'local',
  time: () => video.currentTime,
  paused: () => video.paused,
  seeking: () => video.seeking,
  seek: (t) => { video.currentTime = t; },
  play: () => video.play(),
  pause: () => video.pause(),
  muted: () => video.muted,
  setMuted: (m) => { video.muted = m; },
};

const noMedia = {
  kind: 'none',
  time: () => 0,
  paused: () => true,
  seeking: () => false,
  seek: () => {},
  play: () => Promise.resolve(),
  pause: () => {},
  muted: () => true,
  setMuted: () => {},
};

let media = noMedia;

// YouTube's state goes PLAYING -> BUFFERING -> PLAYING on every seek, so we
// track "playing" ourselves and let buffering keep whatever it was. reading
// the raw state instead makes the play button flicker on each scrub
function makeYtMedia(player) {
  const m = {
    kind: 'youtube',
    playing: false,
    time: () => player.getCurrentTime() || 0,
    paused: () => !m.playing,
    seeking: () => false,
    // allowSeekAhead=false while dragging stops YouTube firing a fresh network
    // request for every pixel. we send one real seek when the drag ends
    seek: (t, precise = true) => player.seekTo(t, precise),
    play: () => { player.playVideo(); return Promise.resolve(); },
    pause: () => player.pauseVideo(),
    // isMuted() lags a mute() by a postMessage round trip, so reading it back
    // straight away shows the wrong icon. we're the only thing muting it (its
    // own controls are off), so our copy is the truth
    isMuted: true,
    muted: () => m.isMuted,
    setMuted: (on) => {
      m.isMuted = on;
      if (on) player.mute(); else player.unMute();
    },
  };
  return m;
}

function onMediaPlay() {
  el('playBtn').classList.add('toggled');
  el('playBtn').setAttribute('aria-label', 'Pause');
  if (!_raf) _raf = requestAnimationFrame(tick);
}

function onMediaPause() {
  el('playBtn').classList.remove('toggled');
  el('playBtn').setAttribute('aria-label', 'Play');
  if (_drag) return;
  uiTime = media.time();
  layoutPlayhead();
}

// a selection that runs to the very end never sees time >= selOut in tick,
// the player stops first. so the loop has to restart from here too
function onMediaEnded() {
  onMediaPause();
  if (!loopSelection || !duration) return;
  seekMain(selIn);
  media.play().catch(() => {});
}

function syncMuteButton() {
  const muted = media.muted();
  el('muteBtn').classList.toggle('toggled', muted);
  el('muteBtn').setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
}

video.addEventListener('play', () => { if (media === localMedia) onMediaPlay(); });
video.addEventListener('pause', () => { if (media === localMedia) onMediaPause(); });
video.addEventListener('ended', () => { if (media === localMedia) onMediaEnded(); });

// ---------------------------------------------------------------------------
// seeking and frame reading (local only)
// ---------------------------------------------------------------------------
// resolves once the element has decoded the frame at t. every seek gets a
// timeout, since a decoder that chokes on one frame otherwise hangs the whole
// export with the progress bar frozen and no error
function seekVideo(v, t) {
  return new Promise((resolve, reject) => {
    // no seeked event fires when we're already sitting on t, so don't wait for one
    if (!v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - t) < 1e-6) return resolve();
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('the video errored while seeking')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('seek timed out')); }, SEEK_TIMEOUT_MS);
    function cleanup() {
      clearTimeout(timer);
      v.removeEventListener('seeked', done);
      v.removeEventListener('error', fail);
    }
    v.addEventListener('seeked', done);
    v.addEventListener('error', fail);
    v.currentTime = t;
  });
}

// draws the grabber's current frame at w x h and hands back the RGBA bytes.
// the video comes from a blob: URL, which is same-origin, so the canvas never
// gets tainted and getImageData can't throw a SecurityError on us
function grabFrame(w, h) {
  if (!_grabCtx || _grabCanvas.width !== w || _grabCanvas.height !== h) {
    _grabCanvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    _grabCtx = _grabCanvas.getContext('2d', { willReadFrequently: true });
    _grabCtx.imageSmoothingQuality = 'high';
  }
  _grabCtx.drawImage(grabber, 0, 0, w, h);
  return _grabCtx.getImageData(0, 0, w, h).data;
}

function concatRGBA(list) {
  if (list.length === 1) return list[0];
  let total = 0;
  for (const d of list) total += d.length;
  const out = new Uint8ClampedArray(total);
  let off = 0;
  for (const d of list) { out.set(d, off); off += d.length; }
  return out;
}

// ---------------------------------------------------------------------------
// loading. the picker, drag-drop and URL paths all end up in loadVideoBlob,
// so a format that works one way works every way. there's deliberately no
// extension whitelist: whatever the browser can decode is supported, and
// anything it can't gets the same error no matter how it arrived. a YouTube
// link is the one exception, it goes to openYouTube instead
// ---------------------------------------------------------------------------
function attachSource(v, url) {
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('decode failed')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('timed out')); }, LOAD_TIMEOUT_MS);
    function cleanup() {
      clearTimeout(timer);
      v.removeEventListener('loadeddata', ok);
      v.removeEventListener('error', fail);
    }
    v.addEventListener('loadeddata', ok);
    v.addEventListener('error', fail);
    v.src = url;
    v.load();
  });
}

// MediaRecorder webm files ship without a duration, so the element reports
// Infinity until it's read to the end. seeking way past the end makes it scan
// and fill in the real value. without this the timeline has no scale at all
async function resolveDuration(v) {
  if (Number.isFinite(v.duration) && v.duration > 0) return v.duration;
  try { await seekVideo(v, 1e7); } catch { /* fall through to whatever we got */ }
  const d = v.duration;
  try { await seekVideo(v, 0); } catch { /* the check below still guards us */ }
  return Number.isFinite(d) && d > 0 ? d : 0;
}

function teardownYouTube() {
  if (!yt) return;
  try { yt.player.destroy(); } catch { /* already gone, nothing to free */ }
  yt = null;
  el('ytBox').replaceChildren();
  el('ytWrap').classList.remove('show');
}

// back to the empty state, whatever was loaded
function unloadAll() {
  media.pause();
  teardownYouTube();
  media = noMedia;
  mode = 'none';
  duration = 0;
  viewStart = viewEnd = 0;
  _pendingSeek = null;
  video.classList.remove('show');
  el('empty').classList.remove('hide');
  el('dock').classList.add('disabled');
  el('panel').classList.remove('yt');
  onMediaPause();
  for (const v of [video, grabber, thumber]) {
    v.removeAttribute('src');
    v.load();
  }
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = null;
  _thumbs = [];
  drawFilmstrip();
  refreshAll();
}

function busyGuard() {
  if (exporting) { status('Wait for the GIF to finish first.', 'error'); return true; }
  if (ytFetchAbort) { status('Wait for the YouTube section to finish first.', 'error'); return true; }
  return false;
}

// opts: { selIn, selOut, offset, fromYouTube } when the blob is a section we
// just fetched from YouTube, so the stoppers land where you put them there
async function loadVideoBlob(blob, name, opts = {}) {
  if (exporting) return status('Wait for the GIF to finish first.', 'error');
  const gen = ++loadGeneration;
  unloadAll();
  if (!opts.fromYouTube) ytReturn = null;
  videoUrl = URL.createObjectURL(blob);
  videoName = sanitiseName(name);
  timeOffset = opts.offset || 0;
  status('Loading video...', 'busy');

  try {
    await Promise.all([video, grabber, thumber].map((v) => attachSource(v, videoUrl)));
  } catch {
    if (gen !== loadGeneration) return;
    unloadAll();
    return status("Your browser can't decode that video. try an mp4 (H.264) or webm", 'error', 6000);
  }
  if (gen !== loadGeneration) return;

  const d = await resolveDuration(video);
  if (gen !== loadGeneration) return;
  if (!d || !video.videoWidth) {
    unloadAll();
    return status('That file has no video track we can read.', 'error', 6000);
  }

  mode = 'local';
  media = localMedia;
  duration = d;
  const hasSel = Number.isFinite(opts.selIn) && Number.isFinite(opts.selOut);
  selIn = hasSel ? clamp(opts.selIn, 0, duration) : 0;
  selOut = hasSel ? clamp(opts.selOut, selIn + minSelection(), duration) : Math.min(duration, DEFAULT_SELECTION_S);
  selIn = Math.min(selIn, selOut - minSelection());
  uiTime = selIn;
  video.currentTime = selIn;

  video.classList.add('show');
  el('empty').classList.add('hide');
  el('dock').classList.remove('disabled');
  el('widthRange').max = String(Math.max(64, video.videoWidth));
  el('timeTotal').textContent = fmtTime(duration);
  syncMuteButton();

  setView(0, duration);
  refreshAll();
  status(`Loaded ${videoName} (${video.videoWidth}x${video.videoHeight}, ${fmtTime(duration)})`);
  buildFilmstrip(gen);
}

async function loadFromUrl(raw) {
  const ytLink = parseYouTubeUrl(raw.trim());
  if (ytLink) {
    if (busyGuard()) return;
    ytReturn = null;
    return openYouTube(ytLink.id, { at: ytLink.at });
  }

  let url;
  try { url = new URL(raw.trim()); } catch { return status('That URL doesn\'t parse.', 'error'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return status('Only http and https links work.', 'error');
  }
  if (busyGuard()) return;

  if (urlAbort) urlAbort.abort();
  const abort = new AbortController();
  urlAbort = abort;

  // always through our own proxy, never a direct fetch: a cross-origin video
  // taints the canvas and getImageData throws, and on an https deploy a plain
  // http link would get blocked as mixed content anyway. relative path so it
  // still works when the app lives under a sub-path
  status('Fetching video...', 'busy');
  try {
    const res = await fetch(`proxy?url=${encodeURIComponent(url.href)}`, { signal: abort.signal });
    if (!res.ok) {
      const msg = (await res.text().catch(() => '')).slice(0, 160);
      throw new Error(msg || `server responded ${res.status}`);
    }
    const blob = await readWithProgress(res, (got, total) => {
      const mb = (got / 1048576).toFixed(1);
      status(total ? `Fetching video... ${Math.round((got / total) * 100)}%` : `Fetching video... ${mb} MB`, 'busy');
    });
    if (abort !== urlAbort) return;
    urlAbort = null;
    const name = decodeURIComponent(url.pathname.split('/').pop() || '') || url.hostname;
    await loadVideoBlob(blob, name);
  } catch (err) {
    if (abort.signal.aborted) return;
    urlAbort = null;
    status(`Couldn't fetch that video: ${err.message}`, 'error', 6000);
  }
}

async function readWithProgress(res, onProgress) {
  const total = Number(res.headers.get('content-length')) || 0;
  const type = res.headers.get('content-type') || 'video/mp4';
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  return new Blob(chunks, { type });
}

// ---------------------------------------------------------------------------
// youtube. the embed is for finding the moment: it can't hand us pixels, so
// "Fetch section" asks the server for just that window, and the clip comes
// back as an ordinary local video for fine-trimming and export. the full
// video never gets downloaded, which matters when it's a 3 hour stream
// ---------------------------------------------------------------------------
// accepts watch, youtu.be, shorts, embed, live and nocookie links, plus a
// t= or start= timestamp in either the query or the hash
function parseYouTubeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') {
    id = u.pathname.slice(1).split('/')[0];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else id = (u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/]+)/) || [])[1];
  }
  if (!id || !YT_ID_RE.test(id)) return null;
  const hashT = (u.hash.match(/[#&]t=([^&]+)/) || [])[1];
  return { id, at: parseYtTime(u.searchParams.get('t') || u.searchParams.get('start') || hashT) };
}

// "90", "90s", "1m30s" and "1h2m3s" all turn up in the wild
function parseYtTime(s) {
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) return 0;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

function loadYouTubeApi() {
  if (_ytApi) return _ytApi;
  _ytApi = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    const fail = (msg) => { _ytApi = null; reject(new Error(msg)); };
    const timer = setTimeout(() => fail('the YouTube player took too long to load'), YT_API_TIMEOUT_MS);
    // the API calls this global when it's ready. chain any existing one
    // rather than clobbering it
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      if (typeof prev === 'function') prev();
      resolve(window.YT);
    };
    const s = document.createElement('script');
    s.src = YT_API_URL;
    s.onerror = () => { clearTimeout(timer); fail("couldn't load the YouTube player (blocked by an extension?)"); };
    document.head.appendChild(s);
  });
  return _ytApi;
}

function ytErrorMessage(code) {
  switch (code) {
    case 2: return 'YouTube says that video id is invalid';
    case 5: return 'YouTube\'s player hit an error with that video';
    case 100: return 'That video is private or has been removed. unlisted works, private doesn\'t';
    case 101: case 150:
      return 'The owner turned embedding off. switch "Allow embedding" on in YouTube Studio, or download it and open the file';
    case 153: return 'YouTube refused the embed because no referrer was sent (check the server\'s Referrer-Policy)';
    default: return `YouTube's player failed (error ${code})`;
  }
}

async function getYtConfig() {
  if (_ytConfig) return _ytConfig;
  try {
    const res = await fetch('yt/config');
    if (!res.ok) throw new Error();
    _ytConfig = await res.json();
  } catch {
    // not cached, so the next try asks again once the server's back
    return { enabled: false, reason: "couldn't reach the server", maxSectionS: 0 };
  }
  return _ytConfig;
}

// opts: { at, selIn, selOut, view } where the last three restore a session
// you left to fetch a clip
async function openYouTube(id, opts = {}) {
  const gen = ++loadGeneration;
  unloadAll();
  mode = 'youtube';
  el('empty').classList.add('hide');
  el('ytWrap').classList.add('show');
  el('panel').classList.add('yt');
  status('Loading YouTube player...', 'busy');
  getYtConfig().then(() => refreshSettings());

  let YTns;
  try {
    YTns = await loadYouTubeApi();
  } catch (err) {
    if (gen !== loadGeneration) return;
    unloadAll();
    return status(err.message, 'error', 6000);
  }
  if (gen !== loadGeneration) return;

  // the API swaps the element we hand it for its iframe, so it gets a fresh
  // one each time
  const holder = document.createElement('div');
  el('ytBox').replaceChildren(holder);
  let ytm = null;
  let player = null;

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the YouTube player never became ready')), YT_READY_TIMEOUT_MS);
    player = new YTns.Player(holder, {
      host: YT_HOST,
      videoId: id,
      width: '100%',
      height: '100%',
      playerVars: {
        autoplay: 0,
        controls: 0,          // the dock is the control surface, two sets would fight
        disablekb: 1,         // our shortcuts, not YouTube's
        fs: 0,
        iv_load_policy: 3,
        playsinline: 1,
        rel: 0,
        start: Math.floor(opts.at || 0),
      },
      events: {
        onReady: () => { clearTimeout(timer); resolve(); },
        onError: (e) => {
          clearTimeout(timer);
          const msg = ytErrorMessage(e.data);
          // before ready it's a load failure. after ready it's usually the
          // embedding-disabled case, which only shows up once it tries to play
          if (!ytm) return reject(new Error(msg));
          if (gen === loadGeneration) status(msg, 'error', 8000);
        },
        onStateChange: (e) => {
          if (!ytm || media !== ytm) return;
          const S = YTns.PlayerState;
          if (e.data === S.PLAYING) { ytm.playing = true; onMediaPlay(); }
          else if (e.data === S.PAUSED || e.data === S.CUED) { ytm.playing = false; onMediaPause(); }
          else if (e.data === S.ENDED) { ytm.playing = false; onMediaEnded(); }
        },
      },
    });
  });

  try {
    await ready;
    if (gen !== loadGeneration) { try { player.destroy(); } catch {} return; }
    // getDuration is 0 until the metadata lands, which can trail onReady by a
    // beat on a long stream
    let d = 0;
    for (let i = 0; i < 50 && !(d > 0); i++) {
      d = player.getDuration();
      if (!(d > 0)) await new Promise((r) => setTimeout(r, 100));
      if (gen !== loadGeneration) { try { player.destroy(); } catch {} return; }
    }
    if (!(d > 0)) throw new Error("YouTube couldn't load that video. check the link (live streams don't work)");

    let title = id;
    try { title = player.getVideoData().title || id; } catch { /* undocumented call, the id will do */ }
    yt = { id, title, player };
    ytm = makeYtMedia(player);
    media = ytm;
    ytm.setMuted(true); // same default as local files, and autoplay rules like it better
    duration = d;

    const at = clamp(opts.at || 0, 0, duration);
    const hasSel = Number.isFinite(opts.selIn) && Number.isFinite(opts.selOut);
    selIn = hasSel ? clamp(opts.selIn, 0, duration) : Math.min(at, Math.max(0, duration - DEFAULT_YT_SELECTION_S));
    selOut = hasSel ? clamp(opts.selOut, selIn, duration) : Math.min(duration, selIn + DEFAULT_YT_SELECTION_S);
    uiTime = at;
    if (at > 0) media.seek(at, true);

    el('dock').classList.remove('disabled');
    el('timeTotal').textContent = fmtTime(duration);
    syncMuteButton();
    if (opts.view) setView(opts.view[0], opts.view[1]); else setView(0, duration);
    refreshAll();
    status(`Loaded "${title}" (${fmtTime(duration)}) from YouTube`);
  } catch (err) {
    if (gen !== loadGeneration) return;
    unloadAll();
    status(err.message, 'error', 8000);
  }
}

function ytFetchWindow() {
  return { a: Math.max(0, selIn - YT_PAD_S), b: Math.min(duration, selOut + YT_PAD_S) };
}

// the longest selection the server will take once our padding's added on
function ytMaxSelection(cfg) {
  return Math.max(0, (cfg.maxSectionS || 0) - 2 * YT_PAD_S);
}

async function fetchYouTubeClip() {
  if (mode !== 'youtube' || !yt || ytFetchAbort || exporting) return;
  const cfg = await getYtConfig();
  if (!cfg.enabled) return status(`Can't fetch: ${cfg.reason}`, 'error', 6000);
  if (selOut - selIn > ytMaxSelection(cfg)) {
    return status(`Sections are capped at ${ytMaxSelection(cfg)} s. tighten the stoppers`, 'error');
  }

  const { a, b } = ytFetchWindow();
  const session = { id: yt.id, title: yt.title, at: uiTime, selIn, selOut, view: [viewStart, viewEnd] };
  media.pause();

  const abort = new AbortController();
  ytFetchAbort = abort;
  refreshSettings();
  el('capture').classList.add('show');
  el('capBar').classList.add('indeterminate');
  const started = Date.now();
  const elapsed = () => Math.round((Date.now() - started) / 1000);
  setCapProgress(0, 'YouTube is cutting the section...');
  el('capPct').textContent = '0 s';
  // the server only answers once yt-dlp's done, so all we can show until
  // bytes arrive is that time's passing
  const ticker = setInterval(() => { el('capPct').textContent = `${elapsed()} s`; }, 500);

  try {
    const res = await fetch(`yt/clip?id=${encodeURIComponent(session.id)}&start=${a.toFixed(3)}&end=${b.toFixed(3)}`, { signal: abort.signal });
    if (!res.ok) {
      const msg = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(msg || `server responded ${res.status}`);
    }
    clearInterval(ticker);
    // how far from `a` the clip's first frame sits: 0 for H.264, up to a
    // keyframe interval either way for VP9/AV1 (see normaliseStart on the
    // server). the clamp only guards against a nonsense header
    const lead = clamp(Number(res.headers.get('x-clip-lead')) || 0, -(b - a), b - a);
    el('capBar').classList.remove('indeterminate');
    setCapProgress(0, 'Downloading section...');
    const blob = await readWithProgress(res, (got, total) => {
      if (total) setCapProgress(got / total);
      else el('capPct').textContent = `${(got / 1048576).toFixed(1)} MB`;
    });
    ytFetchAbort = null;
    el('capture').classList.remove('show');
    ytReturn = session;
    await loadVideoBlob(blob, session.title, {
      selIn: session.selIn - a - lead,
      selOut: session.selOut - a - lead,
      offset: a + lead,
      fromYouTube: true,
    });
  } catch (err) {
    if (abort.signal.aborted) status('Cancelled.');
    else status(`Couldn't fetch that section: ${err.message}`, 'error', 8000);
  } finally {
    clearInterval(ticker);
    if (ytFetchAbort === abort) ytFetchAbort = null;
    el('capBar').classList.remove('indeterminate');
    el('capture').classList.remove('show');
    refreshSettings();
  }
}

function backToYouTube() {
  if (!ytReturn || busyGuard()) return;
  const r = ytReturn;
  openYouTube(r.id, { at: r.at, selIn: r.selIn, selOut: r.selOut, view: r.view });
}

// ---------------------------------------------------------------------------
// filmstrip
// ---------------------------------------------------------------------------
// grabbed once per video at a fixed count, then tiled to whatever slice the
// timeline shows, so a resize or a zoom only redraws and never re-decodes
async function buildFilmstrip(gen) {
  _thumbs = [];
  const vw = thumber.videoWidth, vh = thumber.videoHeight;
  if (!vw || !vh) return drawFilmstrip();
  const tileW = (timeline.clientHeight * vw) / vh;
  const count = clamp(Math.ceil(timeline.clientWidth / Math.max(1, tileW)), 4, MAX_THUMBS);
  const tw = Math.max(1, Math.round((THUMB_PX * vw) / vh));

  for (let i = 0; i < count; i++) {
    const t = Math.min(duration - END_EPSILON_S, ((i + 0.5) / count) * duration);
    try {
      await seekVideo(thumber, t);
    } catch {
      continue; // a missing tile is fine, the neighbours fill the gap
    }
    if (gen !== loadGeneration) return;
    const c = Object.assign(document.createElement('canvas'), { width: tw, height: THUMB_PX });
    c.getContext('2d').drawImage(thumber, 0, 0, tw, THUMB_PX);
    _thumbs.push({ t, canvas: c });
    drawFilmstrip();
  }
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawFilmstrip() {
  const c = el('filmstrip');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!duration) return;
  if (!_thumbs.length) return drawTicks(ctx, w, h, dpr);

  const aspect = _thumbs[0].canvas.width / _thumbs[0].canvas.height;
  const tileW = h * aspect;
  const tiles = Math.ceil(w / tileW);
  for (let j = 0; j < tiles; j++) {
    const x = j * tileW;
    const tMid = viewStart + ((x + tileW / 2) / w) * viewSpan();
    let best = _thumbs[0];
    for (const th of _thumbs) {
      if (Math.abs(th.t - tMid) < Math.abs(best.t - tMid)) best = th;
    }
    ctx.drawImage(best.canvas, x, 0, tileW, h);
  }
}

// a YouTube timeline has no frames to show (the embed won't give us any), so
// it gets a ruler instead. on a 3 hour match that's what you navigate by
function drawTicks(ctx, w, h, dpr) {
  const pxPerS = w / dpr / viewSpan();
  const stepS = TICK_STEPS_S.find((s) => s * pxPerS >= MIN_TICK_GAP_PX) || TICK_STEPS_S[TICK_STEPS_S.length - 1];
  const minor = stepS / 5;
  ctx.font = `${10 * dpr}px ${cssVar('--mono')}`;
  ctx.textBaseline = 'top';
  for (let t = Math.ceil(viewStart / minor) * minor; t <= viewEnd; t += minor) {
    const x = Math.round(((t - viewStart) / viewSpan()) * w) + 0.5;
    const major = Math.abs(t / stepS - Math.round(t / stepS)) < 1e-6;
    ctx.fillStyle = major ? cssVar('--muted') : cssVar('--line');
    ctx.fillRect(x, major ? h * 0.45 : h * 0.7, dpr, h);
    if (major) ctx.fillText(fmtTick(t, stepS), x + 4 * dpr, 6 * dpr);
  }
}

// ---------------------------------------------------------------------------
// timeline, zoom, stoppers and playhead
// ---------------------------------------------------------------------------
const viewSpan = () => Math.max(1e-6, viewEnd - viewStart);
const pct = (t) => (duration ? ((t - viewStart) / viewSpan()) * 100 : 0);
const inView = (t) => t >= viewStart - 1e-6 && t <= viewEnd + 1e-6;

function setView(a, b) {
  if (!duration) { viewStart = viewEnd = 0; return; }
  const span = clamp(b - a, Math.min(MIN_VIEW_S, duration), duration);
  viewStart = clamp(a, 0, duration - span);
  viewEnd = viewStart + span;
  el('zoomFitBtn').classList.toggle('on', span < duration - 1e-6);
  drawFilmstrip();
  layoutTimeline();
}

function zoomToSelection() {
  const span = selOut - selIn;
  const pad = Math.max(span * ZOOM_SEL_PAD, MIN_VIEW_S / 2);
  setView(selIn - pad, selOut + pad);
}

// z flips between the whole video and the selection
function toggleZoom() {
  if (viewSpan() < duration - 1e-6) setView(0, duration);
  else zoomToSelection();
}

function xToTime(clientX) {
  const r = timeline.getBoundingClientRect();
  return clamp(viewStart + ((clientX - r.left) / Math.max(1, r.width)) * viewSpan(), 0, duration);
}

function minSelection() {
  return Math.min(MIN_SELECTION_S, duration);
}

function maxSelection() {
  return Math.min(MAX_GIF_LENGTH_S, duration);
}

function layoutTimeline() {
  const a = clamp(pct(selIn), 0, 100), b = clamp(pct(selOut), 0, 100);
  el('shadeL').style.width = `${a}%`;
  el('shadeR').style.width = `${100 - b}%`;
  el('selBox').style.left = `${a}%`;
  el('selBox').style.width = `${b - a}%`;
  el('selBox').style.visibility = b > a ? '' : 'hidden';
  // zoomed in, a stopper can be off-screen. it hides rather than pinning to
  // the edge, where it would look like the selection ends somewhere it doesn't
  for (const [id, t] of [['handleIn', selIn], ['handleOut', selOut]]) {
    const h = el(id);
    h.style.left = `${pct(t)}%`;
    h.style.visibility = inView(t) ? '' : 'hidden';
    h.setAttribute('aria-valuemin', '0');
    h.setAttribute('aria-valuemax', duration.toFixed(2));
    h.setAttribute('aria-valuenow', t.toFixed(2));
    h.setAttribute('aria-valuetext', fmtTime(t));
  }
  // skip whichever one you're mid-typing in, or a keystroke would get
  // overwritten out from under you on the next refresh
  if (document.activeElement !== el('inVal')) el('inVal').value = fmtTime(selIn);
  if (document.activeElement !== el('outValTime')) el('outValTime').value = fmtTime(selOut);
  el('lenVal').textContent = `(${(selOut - selIn).toFixed(2)} s)`;
  layoutPlayhead();
}

function layoutPlayhead() {
  el('playhead').style.left = `${pct(uiTime)}%`;
  el('playhead').style.visibility = duration && inView(uiTime) ? '' : 'hidden';
  el('timeNow').textContent = fmtTime(uiTime);
}

// the stoppers only ever move through these two, so in < out always holds,
// and the span is always within [minSelection, maxSelection]
function setIn(t) {
  selIn = clamp(t, Math.max(0, selOut - maxSelection()), selOut - minSelection());
}

function setOut(t) {
  selOut = clamp(t, selIn + minSelection(), Math.min(duration, selIn + maxSelection()));
}

// the keyboard/button versions. setting in past the current out drags out
// along (keeping the span) instead of refusing, which is what NLEs do and what
// your fingers expect
function markIn(t) {
  const span = selOut - selIn;
  if (t > selOut - minSelection()) selOut = clamp(t + span, t + minSelection(), duration);
  setIn(t);
  refreshAll();
}

function markOut(t) {
  const span = selOut - selIn;
  if (t < selIn + minSelection()) selIn = clamp(t - span, 0, t - minSelection());
  setOut(t);
  refreshAll();
}

// scrubbing fires far faster than a decoder can seek. assigning currentTime
// mid-seek aborts the one in flight, so a fast drag would never land and
// the picture would freeze. instead we park the newest target and fire it
// when the current seek finishes. precise=false is the YouTube drag case
function seekMain(t, precise = true) {
  uiTime = clamp(t, 0, duration);
  layoutPlayhead();
  if (media.seeking()) { _pendingSeek = uiTime; return; }
  media.seek(uiTime, precise);
}

video.addEventListener('seeked', () => {
  if (media !== localMedia) return;
  if (_pendingSeek !== null) {
    const t = _pendingSeek;
    _pendingSeek = null;
    video.currentTime = t;
    return;
  }
  // keep the readout honest when something other than us moves the playhead
  if (_drag || !video.paused) return;
  uiTime = video.currentTime;
  layoutPlayhead();
});

timeline.addEventListener('pointerdown', (e) => {
  if (!duration || e.button !== 0) return;
  e.preventDefault();
  const t = xToTime(e.clientX);
  let kind = 'scrub';
  if (e.target === el('handleIn')) kind = 'in';
  else if (e.target === el('handleOut')) kind = 'out';
  else if (e.target === el('selBox')) kind = 'sel';

  // the offset keeps whatever you grabbed exactly under your pointer, so the
  // stopper doesn't jump by half its width the moment you touch it
  const offset = kind === 'out' ? t - selOut : kind === 'scrub' ? 0 : t - selIn;
  _drag = { kind, pointerId: e.pointerId, offset, span: selOut - selIn };
  timeline.setPointerCapture(e.pointerId);

  if (kind === 'in' || kind === 'out') {
    e.target.focus();
    media.pause();
  }
  if (kind === 'scrub') seekMain(t, false);
});

timeline.addEventListener('pointermove', (e) => {
  if (!_drag || e.pointerId !== _drag.pointerId) return;
  const t = xToTime(e.clientX) - _drag.offset;
  if (_drag.kind === 'in') {
    setIn(t);
    seekMain(selIn, false);
  } else if (_drag.kind === 'out') {
    setOut(t);
    seekMain(selOut, false);
  } else if (_drag.kind === 'sel') {
    selIn = clamp(t, 0, duration - _drag.span);
    selOut = selIn + _drag.span;
    seekMain(selIn, false);
  } else {
    seekMain(t, false);
  }
  refreshAll();
});

function endDrag(e) {
  if (!_drag || e.pointerId !== _drag.pointerId) return;
  _drag = null;
  // the drag only sent YouTube cheap seeks, this is the one that loads the frame
  if (media.kind === 'youtube') media.seek(uiTime, true);
  refreshAll();
}
timeline.addEventListener('pointerup', endDrag);
timeline.addEventListener('pointercancel', endDrag);

// the wheel zooms around whatever's under the pointer, and a sideways swipe
// (or shift + wheel) pans. without this a 3 hour video is about 7 s per pixel
// and there's no landing a stopper on a particular moment
timeline.addEventListener('wheel', (e) => {
  if (!duration) return;
  e.preventDefault();
  const r = timeline.getBoundingClientRect();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.width : 1; // lines and pages to px
  const dx = (e.shiftKey ? e.deltaY : e.deltaX) * unit;
  const dy = (e.shiftKey ? 0 : e.deltaY) * unit;
  if (Math.abs(dx) > Math.abs(dy)) {
    const shift = (dx / r.width) * viewSpan();
    setView(viewStart + shift, viewEnd + shift);
    return;
  }
  const anchor = xToTime(e.clientX);
  const frac = (anchor - viewStart) / viewSpan();
  const span = viewSpan() * Math.exp(dy * ZOOM_WHEEL_RATE);
  setView(anchor - frac * span, anchor - frac * span + span);
}, { passive: false });

new ResizeObserver(() => drawFilmstrip()).observe(timeline);

// arrow keys on a focused stopper nudge it a frame at a time, which is the
// only way to land one on an exact frame when the video is long and a pixel
// of timeline covers a second or more
for (const [id, isIn] of [['handleIn', true], ['handleOut', false]]) {
  el(id).addEventListener('keydown', (e) => {
    if (!duration || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    e.stopPropagation();
    const stepS = (e.shiftKey ? BIG_STEP_S : FRAME_STEP_S) * (e.key === 'ArrowLeft' ? -1 : 1);
    media.pause();
    if (isIn) { setIn(selIn + stepS); seekMain(selIn); } else { setOut(selOut + stepS); seekMain(selOut); }
    refreshAll();
  });
}

// ---------------------------------------------------------------------------
// playback
// ---------------------------------------------------------------------------
function togglePlay() {
  if (!duration) return;
  if (!media.paused()) return media.pause();
  // starting from outside the selection with loop on would play into the
  // shaded part and then snap back, which reads as a glitch. start at in
  if (loopSelection && (uiTime < selIn || uiTime >= selOut - FRAME_STEP_S)) seekMain(selIn);
  media.play().catch((err) => status(`Playback failed: ${err.message}`, 'error'));
}

function tick() {
  if (media.paused()) { _raf = 0; return; }
  if (!_drag) {
    uiTime = media.time();
    if (loopSelection && uiTime >= selOut) {
      uiTime = selIn;
      media.seek(selIn, true);
    }
    // when zoomed, page the view along so the playhead never runs off the end
    if (!inView(uiTime)) {
      const span = viewSpan();
      setView(uiTime - span * 0.1, uiTime + span * 0.9);
    }
    layoutPlayhead();
  }
  _raf = requestAnimationFrame(tick);
}

function toggleMute() {
  media.setMuted(!media.muted());
  syncMuteButton();
}

function toggleLoopSelection() {
  loopSelection = !loopSelection;
  el('loopSelBtn').classList.toggle('on', loopSelection);
}

function step(delta) {
  if (!duration) return;
  media.pause();
  seekMain(uiTime + delta);
}

// ---------------------------------------------------------------------------
// settings panel
// ---------------------------------------------------------------------------
function outputSize() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (mode !== 'local' || !vw || !vh) return null;
  const w = clamp(settings.width || vw, 16, vw); // never upscale, it only adds bytes
  return { w, h: Math.max(2, Math.round((w * vh) / vw)) };
}

// the source timestamps each GIF frame is read from. one GIF frame lasts
// delayCs, and at speed 2 that same frame has to cover twice as much of the
// source, so the step through the video is delay * speed
function frameTimes() {
  if (mode !== 'local') return [];
  const stepS = (settings.delayCs / 100) * settings.speed;
  const count = Math.max(1, Math.round((selOut - selIn) / stepS));
  const last = duration - END_EPSILON_S;
  const fwd = [];
  for (let i = 0; i < count; i++) fwd.push(Math.min(last, selIn + i * stepS));
  if (!settings.boomerang || count < 3) return fwd;
  // skip both end frames on the way back, or each one shows twice in a row
  // and the turnaround visibly stutters
  return fwd.concat(fwd.slice(1, -1).reverse());
}

const fpsOf = (delayCs) => 100 / delayCs;
const fmtFps = (delayCs) => `${+fpsOf(delayCs).toFixed(1)} fps`;

function syncSeg(segId, attr, value) {
  for (const b of el(segId).querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset[attr] === String(value));
  }
}

function refreshYtPanel() {
  const cfg = _ytConfig;
  const len = selOut - selIn;
  const max = cfg ? ytMaxSelection(cfg) : 0;
  const over = cfg && cfg.enabled && len > max;
  const { a, b } = ytFetchWindow();
  el('ytTitle').textContent = yt ? yt.title : 'Loading...';
  el('ytLenVal').textContent = duration ? fmtTime(duration) : '-';
  el('ytSelVal').textContent = duration ? `${len.toFixed(2)} s` : '-';
  el('ytSelVal').classList.toggle('over', !!over);
  el('ytMaxVal').textContent = cfg && cfg.enabled ? `${max} s` : '-';
  el('ytWindowVal').textContent = duration ? `${fmtTime(a)} - ${fmtTime(b)}` : '-';

  const warn = el('ytWarn');
  let msg = '';
  if (cfg && !cfg.enabled) msg = `Fetching is unavailable: ${cfg.reason}. you can still browse`;
  else if (over) msg = `That's longer than ${max} s. tighten the stoppers (z zooms to them)`;
  warn.hidden = !msg;
  warn.textContent = msg;
  el('ytFetchBtn').disabled = !yt || !cfg || !cfg.enabled || over || !!ytFetchAbort;
}

function refreshSettings() {
  const isYt = mode === 'youtube';
  el('panelTitle').replaceChildren(...(isYt ? ['youtube ', bold('section')] : ['gif ', bold('settings')]));
  el('ytBackBtn').hidden = !(mode === 'local' && ytReturn);
  if (isYt) return refreshYtPanel();

  const size = outputSize();
  const quality = QUALITY_PRESETS.findIndex(
    (p) => p.colours === settings.colours && p.palette === settings.palette,
  );

  syncSeg('sizeSeg', 'width', settings.width);
  syncSeg('smoothSeg', 'delay', settings.delayCs);
  syncSeg('qualitySeg', 'quality', quality);
  syncSeg('paletteSeg', 'palette', settings.palette);
  syncSeg('loopSeg', 'repeat', settings.repeat);
  syncSeg('boomSeg', 'boom', settings.boomerang ? 1 : 0);

  el('sizeVal').textContent = size ? `${size.w}x${size.h}` : settings.width ? `${settings.width} wide` : 'source';
  el('smoothVal').textContent = fmtFps(settings.delayCs);
  el('qualityVal').textContent = `${settings.colours} colours`;

  // sliders get written only when they're not the thing being dragged, or
  // the fps slider would snap under your thumb to the nearest whole-cs value
  const widthRange = el('widthRange');
  if (document.activeElement !== widthRange) widthRange.value = String(settings.width || widthRange.max);
  if (document.activeElement !== el('fpsRange')) el('fpsRange').value = String(Math.round(fpsOf(settings.delayCs)));
  el('coloursRange').value = String(settings.colours);
  el('speedRange').value = String(settings.speed);
  el('widthVal').textContent = size ? `${size.w}px` : settings.width ? `${settings.width}px` : 'source';
  el('fpsVal').textContent = `${fmtFps(settings.delayCs)} (${settings.delayCs}cs)`;
  el('coloursVal').textContent = settings.colours;
  el('speedVal').textContent = `${settings.speed}x`;

  const local = mode === 'local';
  const times = frameTimes();
  const tooMany = times.length > MAX_FRAMES;
  el('clipVal').textContent = local ? `${fmtTime(selIn + timeOffset)} - ${fmtTime(selOut + timeOffset)}` : '-';
  el('outVal').textContent = size ? `${size.w}x${size.h}` : '-';
  el('framesVal').textContent = local ? String(times.length) : '-';
  el('framesVal').classList.toggle('over', tooMany);
  el('lengthVal').textContent = local ? `${((times.length * settings.delayCs) / 100).toFixed(2)} s` : '-';

  const warn = el('frameWarn');
  warn.hidden = !tooMany;
  warn.textContent = tooMany
    ? `That's over ${MAX_FRAMES} frames. shorten the selection, drop the frame rate, or speed it up`
    : '';
  el('exportBtn').disabled = !local || tooMany || exporting;
}

function bold(text) {
  const b = document.createElement('b');
  b.textContent = text;
  return b;
}

function refreshAll() {
  layoutTimeline();
  refreshSettings();
}

function wireSeg(segId, onPick) {
  el(segId).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    onPick(b.dataset);
    refreshSettings();
  });
}

wireSeg('sizeSeg', (d) => { settings.width = Number(d.width); });
wireSeg('smoothSeg', (d) => { settings.delayCs = Number(d.delay); });
wireSeg('qualitySeg', (d) => { Object.assign(settings, QUALITY_PRESETS[Number(d.quality)]); });
wireSeg('paletteSeg', (d) => { settings.palette = d.palette; });
wireSeg('loopSeg', (d) => { settings.repeat = Number(d.repeat); });
wireSeg('boomSeg', (d) => { settings.boomerang = d.boom === '1'; });

el('widthRange').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  // dragging to the far end means "source width", same as the Full preset
  settings.width = v >= Number(e.target.max) ? 0 : v;
  refreshSettings();
});
el('fpsRange').addEventListener('input', (e) => {
  settings.delayCs = Math.max(MIN_DELAY_CS, Math.round(100 / Number(e.target.value)));
  refreshSettings();
});
el('coloursRange').addEventListener('input', (e) => {
  settings.colours = Number(e.target.value);
  refreshSettings();
});
el('speedRange').addEventListener('input', (e) => {
  settings.speed = Number(e.target.value);
  refreshSettings();
});

// the advanced toggle is remembered per browser. storage can be missing or
// throw (private windows, blocked site data), and that only costs the memory
const ADV_KEY = 'clipStation.advanced';
function setAdvanced(on) {
  el('panel').classList.toggle('advanced', on);
  el('advBtn').classList.toggle('on', on);
  try { localStorage.setItem(ADV_KEY, on ? '1' : '0'); } catch { /* not remembered, still works */ }
}
el('advBtn').addEventListener('click', () => setAdvanced(!el('panel').classList.contains('advanced')));
try { if (localStorage.getItem(ADV_KEY) === '1') setAdvanced(true); } catch { /* default to simple */ }

// ---------------------------------------------------------------------------
// GIF export, via gifenc. all of it runs in the browser and the video never
// leaves the machine, so none of it adds server attack surface. that's
// deliberate: no shelling out to ffmpeg on a file someone else made
// ---------------------------------------------------------------------------
function setCapProgress(p, label) {
  const pc = Math.round(p * 100);
  el('capfill').style.width = `${pc}%`;
  el('capPct').textContent = `${pc}%`;
  if (label) el('capLabel').textContent = label;
}

class CancelledError extends Error {}

async function exportGif() {
  if (exporting || mode !== 'local') return;
  const size = outputSize();
  const times = frameTimes();
  if (!size || !times.length) return;
  if (times.length > MAX_FRAMES) return status(`Too many frames (${times.length}).`, 'error');

  exporting = true;
  cancelExport = false;
  media.pause();
  refreshSettings();
  el('capture').classList.add('show');

  const gen = loadGeneration;
  const { w, h } = size;
  const { colours, repeat } = settings;
  const shared = settings.palette === 'global';
  // gifenc's writeFrame wants the delay in MILLISECONDS (it stores round(ms/10)
  // as centiseconds). we track delayCs, so multiply by 10 on the way in. pass
  // centiseconds straight through and every frame collapses to ~1cs, which
  // browsers clamp to 100ms
  const delayMs = settings.delayCs * 10;
  const format = 'rgb565';
  const bail = () => {
    if (cancelExport || gen !== loadGeneration) throw new CancelledError();
  };

  try {
    // ---- pass 1: sample frames for one shared palette ----------------------
    // spread across the forward run only, since boomerang frames repeat it.
    // too few samples and a colour that only shows up between them gets a bad
    // nearest match and bands for the rest of the GIF
    let palette = null;
    const pass1 = shared ? 0.2 : 0;
    if (shared) {
      setCapProgress(0, 'Sampling colours...');
      const fwdCount = settings.boomerang && times.length >= 3 ? (times.length + 2) / 2 : times.length;
      const n = Math.min(PALETTE_SAMPLES, fwdCount);
      const samples = [];
      for (let i = 0; i < n; i++) {
        bail();
        await seekVideo(grabber, times[Math.floor(((i + 0.5) / n) * fwdCount)]);
        samples.push(grabFrame(w, h));
        setCapProgress(((i + 1) / n) * pass1);
      }
      palette = quantize(concatRGBA(samples), colours, { format });
    }

    // ---- pass 2: encode every frame ----------------------------------------
    // per-frame palettes look better on footage whose colours shift a lot, at
    // the cost of a colour table per frame and some flicker on flat areas as
    // each frame rounds slightly differently
    setCapProgress(pass1, 'Encoding GIF...');
    const gif = GIFEncoder();
    for (let i = 0; i < times.length; i++) {
      bail();
      await seekVideo(grabber, times[i]);
      const data = grabFrame(w, h);
      const framePalette = palette || quantize(data, colours, { format });
      const index = applyPalette(data, framePalette, format);
      // with a shared palette only frame 0 needs it, it becomes the global
      // table. passing it on later frames would write a redundant local copy
      const opts = { delay: delayMs, repeat };
      if (!palette || i === 0) opts.palette = framePalette;
      gif.writeFrame(index, w, h, opts);
      setCapProgress(pass1 + ((i + 1) / times.length) * (0.98 - pass1));
    }
    bail();
    setCapProgress(0.99, 'Finishing...');
    gif.finish();
    const blob = new Blob([gif.bytes()], { type: 'image/gif' });
    setCapProgress(1);
    showResult(blob, { w, h, frames: times.length });
  } catch (err) {
    if (err instanceof CancelledError) status('Cancelled.');
    else status(`GIF failed: ${err.message}`, 'error', 6000);
  } finally {
    exporting = false;
    el('capture').classList.remove('show');
    refreshSettings();
  }
}

function showResult(blob, { w, h, frames }) {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = URL.createObjectURL(blob);
  resultName = `${videoName}-${fmtFileTime(selIn + timeOffset)}-${fmtFileTime(selOut + timeOffset)}.gif`;
  el('resultImg').src = resultUrl;
  const secs = ((frames * settings.delayCs) / 100).toFixed(2);
  const kb = blob.size / 1024;
  const sizeStr = kb >= 1024 ? `${(kb / 1024).toFixed(2)} MB` : `${Math.round(kb)} KB`;
  el('resultInfo').textContent = `${w}x${h}, ${frames} frames, ${secs} s, ${sizeStr}`;
  el('result').classList.add('show');
  el('downloadBtn').focus();
}

function closeResult() {
  el('result').classList.remove('show');
  el('resultImg').removeAttribute('src');
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
el('file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = ''; // so picking the same file again still fires change
  if (f && !busyGuard()) loadVideoBlob(f, f.name);
});

el('urlBtn').addEventListener('click', () => loadFromUrl(el('urlInput').value));
el('urlInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadFromUrl(e.target.value);
});

// dragleave fires every time the pointer crosses into a child element, so a
// plain show/hide flickers. counting enters against leaves settles it
let _dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  _dragDepth++;
  el('drop').classList.add('show');
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', () => {
  _dragDepth = Math.max(0, _dragDepth - 1);
  if (!_dragDepth) el('drop').classList.remove('show');
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  _dragDepth = 0;
  el('drop').classList.remove('show');
  const f = e.dataTransfer.files[0];
  if (f && !busyGuard()) loadVideoBlob(f, f.name);
});

// click (or tab to) the in/out time and type a new one. Enter commits,
// Escape reverts, and just clicking away (blur) commits too, so touch users
// without an Enter key aren't stuck. bad input reverts rather than guessing,
// and a value that clashes with the other stopper drags it along, the same
// as dragging the stopper itself would
function wireTimeEdit(id, isIn) {
  const input = el(id);
  let cancelled = false;
  input.addEventListener('focus', () => { cancelled = false; input.select(); media.pause(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // don't let space/i/o/arrows fire while typing digits
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelled = true; input.blur(); }
  });
  input.addEventListener('blur', () => {
    if (cancelled || !duration) return refreshAll();
    const t = parseTimeInput(input.value);
    if (t === null) { status("that doesn't look like a time, try 1:23.5 or 83.5", 'error'); return refreshAll(); }
    const clamped = clamp(t, 0, duration);
    if (isIn) markIn(clamped); else markOut(clamped);
    seekMain(isIn ? selIn : selOut);
  });
}
wireTimeEdit('inVal', true);
wireTimeEdit('outValTime', false);
el('maxLenHint').textContent = `· gifs capped at ${MAX_GIF_LENGTH_S}s`;

el('playBtn').addEventListener('click', togglePlay);
el('muteBtn').addEventListener('click', toggleMute);
el('loopSelBtn').addEventListener('click', toggleLoopSelection);
el('setInBtn').addEventListener('click', () => markIn(uiTime));
el('setOutBtn').addEventListener('click', () => markOut(uiTime));
el('zoomSelBtn').addEventListener('click', zoomToSelection);
el('zoomFitBtn').addEventListener('click', () => setView(0, duration));
el('exportBtn').addEventListener('click', exportGif);
el('ytFetchBtn').addEventListener('click', fetchYouTubeClip);
el('ytBackBtn').addEventListener('click', backToYouTube);
el('cancelBtn').addEventListener('click', () => {
  cancelExport = true;
  if (ytFetchAbort) ytFetchAbort.abort();
});
el('closeResultBtn').addEventListener('click', closeResult);
el('downloadBtn').addEventListener('click', () => {
  if (resultUrl) downloadBlobUrl(resultUrl, resultName);
});
el('result').addEventListener('click', (e) => { if (e.target === el('result')) closeResult(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (exporting) cancelExport = true;
    else if (ytFetchAbort) ytFetchAbort.abort();
    else if (el('result').classList.contains('show')) closeResult();
    return;
  }
  if (!duration || exporting || ytFetchAbort || el('result').classList.contains('show')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // typing a URL or dragging a slider owns its own keys, and space on a
  // focused button already clicks it
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (tag === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;

  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'i': case 'I': markIn(uiTime); break;
    case 'o': case 'O': markOut(uiTime); break;
    case 'l': case 'L': toggleLoopSelection(); break;
    case 'm': case 'M': toggleMute(); break;
    case 'z': case 'Z': toggleZoom(); break;
    case 'ArrowLeft': e.preventDefault(); step(-(e.shiftKey ? BIG_STEP_S : FRAME_STEP_S)); break;
    case 'ArrowRight': e.preventDefault(); step(e.shiftKey ? BIG_STEP_S : FRAME_STEP_S); break;
    default: return;
  }
});

refreshAll();
