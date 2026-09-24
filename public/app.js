import { GIFEncoder, quantize, applyPalette } from 'https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js';

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------
const MIN_SELECTION_S = 0.1;      // the stoppers can't get closer than this
const DEFAULT_SELECTION_S = 3;    // a fresh video starts with its first 3 s picked
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
const QUALITY_PRESETS = [
  { colours: 64, palette: 'global' },   // small
  { colours: 128, palette: 'global' },  // balanced
  { colours: 256, palette: 'frame' },   // best
];

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

let videoUrl = null;       // object URL shared by all three video elements
let videoName = 'clip';    // sanitised base name, used for the download
let duration = 0;          // 0 means nothing is loaded
let selIn = 0;
let selOut = 0;
let uiTime = 0;            // where the playhead is drawn, which runs ahead of a pending seek
let loopSelection = true;
let loadGeneration = 0;    // bumps on every load so stale async work knows to bail
let urlAbort = null;       // aborts an in-flight URL download when something newer loads
let exporting = false;
let cancelExport = false;
let resultUrl = null;
let resultName = '';
let _pendingSeek = null;   // latest seek asked for while the player was still busy seeking
let _raf = 0;
let _drag = null;          // { kind, pointerId, offset, span, wasPlaying }
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

function fmtTime(t) {
  if (!Number.isFinite(t)) t = 0;
  const cs = Math.round(t * 100);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

// filenames can't carry colons, so 1:02.50 becomes 1m02.50s
const fmtFileTime = (t) => fmtTime(t).replace(':', 'm') + 's';

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
// seeking and frame reading
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
// anything it can't gets the same error no matter how it arrived
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

function unloadVideo() {
  duration = 0;
  video.pause();
  video.classList.remove('show');
  el('empty').classList.remove('hide');
  el('dock').classList.add('disabled');
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

async function loadVideoBlob(blob, name) {
  if (exporting) return status('Wait for the GIF to finish first.', 'error');
  const gen = ++loadGeneration;
  unloadVideo();
  videoUrl = URL.createObjectURL(blob);
  videoName = sanitiseName(name);
  status('Loading video...', 'busy');

  try {
    await Promise.all([video, grabber, thumber].map((v) => attachSource(v, videoUrl)));
  } catch {
    if (gen !== loadGeneration) return;
    unloadVideo();
    return status("Your browser can't decode that video. try an mp4 (H.264) or webm", 'error', 6000);
  }
  if (gen !== loadGeneration) return;

  const d = await resolveDuration(video);
  if (gen !== loadGeneration) return;
  if (!d || !video.videoWidth) {
    unloadVideo();
    return status("That file has no video track we can read.", 'error', 6000);
  }

  duration = d;
  selIn = 0;
  selOut = Math.min(duration, DEFAULT_SELECTION_S);
  uiTime = 0;
  _pendingSeek = null;
  video.currentTime = 0;

  video.classList.add('show');
  el('empty').classList.add('hide');
  el('dock').classList.remove('disabled');
  el('widthRange').max = String(Math.max(64, video.videoWidth));
  el('timeTotal').textContent = fmtTime(duration);

  refreshAll();
  status(`Loaded ${videoName} (${video.videoWidth}x${video.videoHeight}, ${fmtTime(duration)})`);
  buildFilmstrip(gen);
}

async function loadFromUrl(raw) {
  let url;
  try { url = new URL(raw.trim()); } catch { return status('That URL doesn\'t parse.', 'error'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return status('Only http and https links work.', 'error');
  }
  if (exporting) return status('Wait for the GIF to finish first.', 'error');

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
      const mb = (got / 1048576).toFixed(1);
      status(total ? `Fetching video... ${Math.round((got / total) * 100)}%` : `Fetching video... ${mb} MB`, 'busy');
    }
    if (abort !== urlAbort) return;
    urlAbort = null;
    const name = decodeURIComponent(url.pathname.split('/').pop() || '') || url.hostname;
    await loadVideoBlob(new Blob(chunks, { type }), name);
  } catch (err) {
    if (abort.signal.aborted) return;
    urlAbort = null;
    status(`Couldn't fetch that video: ${err.message}`, 'error', 6000);
  }
}

// ---------------------------------------------------------------------------
// filmstrip
// ---------------------------------------------------------------------------
// grabbed once per video at a fixed count, then tiled to whatever width the
// timeline is, so a window resize only redraws and never re-decodes
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

function drawFilmstrip() {
  const c = el('filmstrip');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!_thumbs.length || !duration) return;

  const aspect = _thumbs[0].canvas.width / _thumbs[0].canvas.height;
  const tileW = h * aspect;
  const tiles = Math.ceil(w / tileW);
  for (let j = 0; j < tiles; j++) {
    const x = j * tileW;
    const tMid = ((x + tileW / 2) / w) * duration;
    let best = _thumbs[0];
    for (const th of _thumbs) {
      if (Math.abs(th.t - tMid) < Math.abs(best.t - tMid)) best = th;
    }
    ctx.drawImage(best.canvas, x, 0, tileW, h);
  }
}

// ---------------------------------------------------------------------------
// timeline, stoppers and playhead
// ---------------------------------------------------------------------------
const pct = (t) => (duration ? (t / duration) * 100 : 0);

function xToTime(clientX) {
  const r = timeline.getBoundingClientRect();
  return clamp((clientX - r.left) / Math.max(1, r.width), 0, 1) * duration;
}

function minSelection() {
  return Math.min(MIN_SELECTION_S, duration);
}

function layoutTimeline() {
  const a = pct(selIn), b = pct(selOut);
  el('shadeL').style.width = `${a}%`;
  el('shadeR').style.width = `${100 - b}%`;
  el('selBox').style.left = `${a}%`;
  el('selBox').style.width = `${b - a}%`;
  el('handleIn').style.left = `${a}%`;
  el('handleOut').style.left = `${b}%`;
  for (const [id, t] of [['handleIn', selIn], ['handleOut', selOut]]) {
    const h = el(id);
    h.setAttribute('aria-valuemin', '0');
    h.setAttribute('aria-valuemax', duration.toFixed(2));
    h.setAttribute('aria-valuenow', t.toFixed(2));
    h.setAttribute('aria-valuetext', fmtTime(t));
  }
  el('inVal').textContent = fmtTime(selIn);
  el('outValTime').textContent = fmtTime(selOut);
  el('lenVal').textContent = `(${(selOut - selIn).toFixed(2)} s)`;
  layoutPlayhead();
}

function layoutPlayhead() {
  el('playhead').style.left = `${pct(uiTime)}%`;
  el('timeNow').textContent = fmtTime(uiTime);
}

// the stoppers only ever move through these two, so in < out always holds
function setIn(t) {
  selIn = clamp(t, 0, selOut - minSelection());
}

function setOut(t) {
  selOut = clamp(t, selIn + minSelection(), duration);
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
// when the current seek finishes
function seekMain(t) {
  uiTime = clamp(t, 0, duration);
  layoutPlayhead();
  if (video.seeking) { _pendingSeek = uiTime; return; }
  video.currentTime = uiTime;
}

video.addEventListener('seeked', () => {
  if (_pendingSeek === null) return;
  const t = _pendingSeek;
  _pendingSeek = null;
  video.currentTime = t;
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
  _drag = { kind, pointerId: e.pointerId, offset, span: selOut - selIn, wasPlaying: !video.paused };
  timeline.setPointerCapture(e.pointerId);

  if (kind === 'in' || kind === 'out') {
    e.target.focus();
    video.pause();
  }
  if (kind === 'scrub') seekMain(t);
});

timeline.addEventListener('pointermove', (e) => {
  if (!_drag || e.pointerId !== _drag.pointerId) return;
  const t = xToTime(e.clientX) - _drag.offset;
  if (_drag.kind === 'in') {
    setIn(t);
    seekMain(selIn);
  } else if (_drag.kind === 'out') {
    setOut(t);
    seekMain(selOut);
  } else if (_drag.kind === 'sel') {
    selIn = clamp(t, 0, duration - _drag.span);
    selOut = selIn + _drag.span;
    seekMain(selIn);
  } else {
    seekMain(t);
  }
  refreshAll();
});

function endDrag(e) {
  if (!_drag || e.pointerId !== _drag.pointerId) return;
  _drag = null;
  refreshAll();
}
timeline.addEventListener('pointerup', endDrag);
timeline.addEventListener('pointercancel', endDrag);

// arrow keys on a focused stopper nudge it a frame at a time, which is the
// only way to land one on an exact frame when the video is long and a pixel
// of timeline covers a second or more
for (const [id, isIn] of [['handleIn', true], ['handleOut', false]]) {
  el(id).addEventListener('keydown', (e) => {
    if (!duration || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    e.stopPropagation();
    const step = (e.shiftKey ? BIG_STEP_S : FRAME_STEP_S) * (e.key === 'ArrowLeft' ? -1 : 1);
    video.pause();
    if (isIn) { setIn(selIn + step); seekMain(selIn); } else { setOut(selOut + step); seekMain(selOut); }
    refreshAll();
  });
}

// ---------------------------------------------------------------------------
// playback
// ---------------------------------------------------------------------------
function togglePlay() {
  if (!duration) return;
  if (!video.paused) return video.pause();
  // starting from outside the selection with loop on would play into the
  // shaded part and then snap back, which reads as a glitch. start at in
  if (loopSelection && (uiTime < selIn || uiTime >= selOut - FRAME_STEP_S)) seekMain(selIn);
  video.play().catch((err) => status(`Playback failed: ${err.message}`, 'error'));
}

function tick() {
  if (video.paused) { _raf = 0; return; }
  if (!_drag) {
    uiTime = video.currentTime;
    if (loopSelection && uiTime >= selOut) {
      uiTime = selIn;
      video.currentTime = selIn;
    }
    layoutPlayhead();
  }
  _raf = requestAnimationFrame(tick);
}

video.addEventListener('play', () => {
  el('playBtn').classList.add('toggled');
  el('playBtn').setAttribute('aria-label', 'Pause');
  if (!_raf) _raf = requestAnimationFrame(tick);
});
video.addEventListener('pause', () => {
  el('playBtn').classList.remove('toggled');
  el('playBtn').setAttribute('aria-label', 'Play');
});
// a selection that runs to the very end never sees currentTime >= selOut in
// tick, the element stops first. so the loop has to restart from here too
video.addEventListener('ended', () => {
  if (!loopSelection || !duration) return;
  seekMain(selIn);
  video.play().catch(() => {});
});

function toggleMute() {
  video.muted = !video.muted;
  el('muteBtn').classList.toggle('toggled', video.muted);
  el('muteBtn').setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
}

function toggleLoopSelection() {
  loopSelection = !loopSelection;
  el('loopSelBtn').classList.toggle('on', loopSelection);
}

function step(delta) {
  if (!duration) return;
  video.pause();
  seekMain(uiTime + delta);
}

// ---------------------------------------------------------------------------
// settings panel
// ---------------------------------------------------------------------------
function outputSize() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!duration || !vw || !vh) return null;
  const w = clamp(settings.width || vw, 16, vw); // never upscale, it only adds bytes
  return { w, h: Math.max(2, Math.round((w * vh) / vw)) };
}

// the source timestamps each GIF frame is read from. one GIF frame lasts
// delayCs, and at speed 2 that same frame has to cover twice as much of the
// source, so the step through the video is delay * speed
function frameTimes() {
  if (!duration) return [];
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

function refreshSettings() {
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

  const times = frameTimes();
  const tooMany = times.length > MAX_FRAMES;
  el('clipVal').textContent = duration ? `${fmtTime(selIn)} - ${fmtTime(selOut)}` : '-';
  el('outVal').textContent = size ? `${size.w}x${size.h}` : '-';
  el('framesVal').textContent = duration ? String(times.length) : '-';
  el('framesVal').classList.toggle('over', tooMany);
  el('lengthVal').textContent = duration ? `${((times.length * settings.delayCs) / 100).toFixed(2)} s` : '-';

  const warn = el('frameWarn');
  warn.hidden = !tooMany;
  warn.textContent = tooMany
    ? `That's over ${MAX_FRAMES} frames. shorten the selection, drop the frame rate, or speed it up`
    : '';
  el('exportBtn').disabled = !duration || tooMany || exporting;
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
  if (exporting || !duration) return;
  const size = outputSize();
  const times = frameTimes();
  if (!size || !times.length) return;
  if (times.length > MAX_FRAMES) return status(`Too many frames (${times.length}).`, 'error');

  exporting = true;
  cancelExport = false;
  video.pause();
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
  resultName = `${videoName}-${fmtFileTime(selIn)}-${fmtFileTime(selOut)}.gif`;
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
  if (f) loadVideoBlob(f, f.name);
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
  if (f) loadVideoBlob(f, f.name);
});

el('playBtn').addEventListener('click', togglePlay);
el('muteBtn').addEventListener('click', toggleMute);
el('loopSelBtn').addEventListener('click', toggleLoopSelection);
el('setInBtn').addEventListener('click', () => markIn(uiTime));
el('setOutBtn').addEventListener('click', () => markOut(uiTime));
el('exportBtn').addEventListener('click', exportGif);
el('cancelBtn').addEventListener('click', () => { cancelExport = true; });
el('closeResultBtn').addEventListener('click', closeResult);
el('downloadBtn').addEventListener('click', () => {
  if (resultUrl) downloadBlobUrl(resultUrl, resultName);
});
el('result').addEventListener('click', (e) => { if (e.target === el('result')) closeResult(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (exporting) cancelExport = true;
    else if (el('result').classList.contains('show')) closeResult();
    return;
  }
  if (!duration || exporting || el('result').classList.contains('show')) return;
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
    case 'ArrowLeft': e.preventDefault(); step(-(e.shiftKey ? BIG_STEP_S : FRAME_STEP_S)); break;
    case 'ArrowRight': e.preventDefault(); step(e.shiftKey ? BIG_STEP_S : FRAME_STEP_S); break;
    default: return;
  }
});

// keep the readout honest when something other than us moves the playhead
video.addEventListener('seeked', () => {
  if (_drag || !video.paused || _pendingSeek !== null) return;
  uiTime = video.currentTime;
  layoutPlayhead();
});

new ResizeObserver(() => drawFilmstrip()).observe(timeline);

refreshAll();
