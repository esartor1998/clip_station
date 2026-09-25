import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Agent, fetch as undiciFetch } from 'undici';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// host/port are configurable for deployment, the defaults are fine locally
const PORT = Number(process.env.PORT) || 4183;
const HOST = process.env.HOST || '0.0.0.0'; // 0.0.0.0 so a reverse proxy can reach it

const app = express();
app.disable('x-powered-by');

// behind a reverse proxy, set TRUST_PROXY (e.g. TRUST_PROXY=1, or a subnet) so
// Express reads X-Forwarded-* properly. leave it unset if the app is exposed
// directly: trusting those headers with no proxy in front lets anyone spoof
// their IP, which would let them dodge the rate limit
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', tp === 'true' ? true : /^\d+$/.test(tp) ? Number(tp) : tp);
}

// ---- security headers -------------------------------------------------------
// the page only ever needs its own files, gifenc off jsDelivr, the YouTube
// iframe API, and blob: URLs for the video and the finished GIF. locking
// everything else down means a hostile video (or anything that sneaks past
// the proxy's type check) has nowhere to phone home to and no way to run
// script in our origin. style-src keeps 'unsafe-inline' because the CSS lives
// in index.html. the API script comes off www.youtube.com and pulls its
// widget code from there too, s.ytimg.com is the older host it still uses
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net https://www.youtube.com https://s.ytimg.com",
  "frame-src https://www.youtube-nocookie.com https://www.youtube.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

app.use((_req, res, next) => {
  res.set('Content-Security-Policy', CSP);
  res.set('X-Content-Type-Options', 'nosniff');
  // not no-referrer: YouTube refuses to play an embed that arrives without one
  // (player error 153). this still only sends our origin cross-site, never the
  // path or query
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'DENY');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// ---- find the static files --------------------------------------------------
// prefer a ./public folder, but fall back to this file's own directory so the
// app still runs if everything got downloaded flat (index.html next to this)
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : __dirname;

if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
  console.error(
    '\n  x index.html not found.\n' +
    `    Looked in: ${path.join(__dirname, 'public')} and ${__dirname}\n` +
    '    Make sure index.html and app.js sit in a "public" folder\n' +
    '    next to server.js (or in the same folder as server.js).\n'
  );
}

app.use(express.static(PUBLIC_DIR));

// ---- proxy hardening --------------------------------------------------------
// the only thing the server does besides static files is fetch a video from a
// URL the user pastes, so the page can read its frames without the canvas
// getting tainted by a cross-origin source. that URL is attacker-chosen, so
// this has to defend against SSRF: otherwise someone could point it at
// localhost, internal services, or cloud metadata (169.254.169.254) and read
// back the response. so we block private address ranges, re-check every
// redirect hop, time out, cap the response size, and only pass video through
const MAX_BYTES = Number(process.env.PROXY_MAX_BYTES) || 150 * 1024 * 1024; // 150 MB per video
const FETCH_TIMEOUT_MS = Number(process.env.PROXY_CONNECT_TIMEOUT_MS) || 8000;   // per hop, to headers
const STREAM_DEADLINE_MS = Number(process.env.PROXY_STREAM_TIMEOUT_MS) || 90000; // whole request
const MAX_REDIRECTS = 4;
const MAX_URL_LENGTH = 2048;
const PROXY_DISABLED = /^(1|true|yes)$/i.test(process.env.DISABLE_PROXY || '');

// content types we'll relay. plenty of hosts (S3 especially) serve video as a
// generic octet-stream, so those have to pass too, but html/js/svg never do.
// that keeps this from turning into a general-purpose open proxy
const ALLOWED_TYPE_RE = /^(video\/[\w.+-]+|application\/(octet-stream|mp4|ogg)|binary\/octet-stream)$/i;

// ---- abuse controls ---------------------------------------------------------
// past SSRF the main risk is volume i.e. spamming links to huge files to
// chew up our bandwidth. unlike a 3D model with a pile of textures, one video
// is one request, so the bucket is small and refills slowly. the concurrency
// caps keep sockets and memory bounded
const RL_BURST = Number(process.env.PROXY_RATE_BURST) || 6;               // burst allowance / IP
const RL_REFILL_PER_SEC = Number(process.env.PROXY_RATE_REFILL) || 0.1;   // sustained req/s / IP
const MAX_CONCURRENT = Number(process.env.PROXY_MAX_CONCURRENT) || 8;     // global in-flight
const MAX_CONCURRENT_PER_IP = Number(process.env.PROXY_MAX_CONCURRENT_PER_IP) || 2;

const inFlightPerIp = new Map();  // ip -> count
let inFlight = 0;

// per-IP token bucket. returns a take(ip) that gives 0 if allowed, otherwise
// the Retry-After value in seconds. the proxy and the YouTube fetcher each get
// their own, since one YouTube section costs far more than one proxied file
function makeRateLimiter(burst, refillPerSec) {
  const buckets = new Map(); // ip -> { tokens, last }
  const refill = (b, now) => Math.min(burst, b.tokens + ((now - b.last) / 1000) * refillPerSec);

  // drop idle buckets so the map can't grow forever if someone rotates IPs
  setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) {
      if (refill(b, now) >= burst && now - b.last > 60_000) buckets.delete(ip);
    }
    if (buckets.size > 100_000) buckets.clear(); // hard cap: shed state under a flood
  }, 60_000).unref();

  return function take(ip) {
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b) { b = { tokens: burst, last: now }; buckets.set(ip, b); }
    b.tokens = refill(b, now);
    b.last = now;
    if (b.tokens < 1) return Math.max(1, Math.ceil((1 - b.tokens) / refillPerSec));
    b.tokens -= 1;
    return 0;
  };
}

const takeProxyToken = makeRateLimiter(RL_BURST, RL_REFILL_PER_SEC);

function isPrivateAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;      // this-host / private / loopback
    if (a === 169 && b === 254) return true;                 // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;        // private
    if (a === 192 && b === 168) return true;                 // private
    if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT
    if (a >= 224) return true;                               // multicast / reserved
    return false;
  }
  if (kind === 6) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;              // loopback / unspecified
    if (l.startsWith('fe80')) return true;                  // link-local
    if (l.startsWith('fc') || l.startsWith('fd')) return true; // unique local (fc00::/7)
    const mapped = l.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);  // IPv4-mapped
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // not an IP we recognise, so treat it as unsafe
}

// reject anything that isn't http(s), or that resolves to a private address.
// returns every resolved record (not just one), since a hostname with mixed
// public/private A records has to be rejected as a whole
async function resolveAndValidate(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }
  const host = url.hostname.replace(/^\[|\]$/g, ''); // unwrap IPv6 literals
  let records;
  if (net.isIP(host)) {
    records = [{ address: host, family: net.isIP(host) }];
  } else {
    try {
      records = await dns.lookup(host, { all: true });
    } catch {
      throw new Error('DNS resolution failed');
    }
  }
  for (const r of records) {
    if (isPrivateAddress(r.address)) throw new Error('Blocked private/internal address');
  }
  return { url, records };
}

// DNS rebinding: a resolve-then-fetch-by-hostname proxy like this one has a
// classic hole if the two steps are independent. an attacker's nameserver
// hands back a public IP the FIRST time (so resolveAndValidate passes), then
// switches to 127.0.0.1 or a cloud metadata address for whichever later
// query actually establishes the connection - a TTL of 0 is all that takes,
// and every real DNS server supports it. plain fetch() would do exactly that
// second, independent lookup on its own.
//
// so instead of handing fetch() the hostname and hoping it resolves to the
// same thing we already checked, this pins undici's own connection lookup to
// return only the address(es) resolveAndValidate already approved. no second
// query ever happens - nothing asks the network again, so there is nothing
// for a rebinding nameserver to answer differently. verified empirically,
// not just reasoned about: instrumenting dns.lookup showed a real, separate
// resolution happening inside fetch() with the old code, and zero once this
// lookup override is in place. TLS certificate/hostname validation is a
// separate mechanism from address resolution and stays fully enforced,
// checked against the connect.lookup docs and confirmed with a mismatched
// local cert that a pinned connection still correctly rejects
function pinnedLookup(records) {
  return (_hostname, options, callback) => {
    if (options.all) return callback(null, records);
    const r = records[0];
    callback(null, r.address, r.family);
  };
}

// follow redirects by hand so every hop gets re-checked and re-pinned. a
// public URL can 302 to an internal one, and automatic redirects would sail
// straight past the IP check on the hop that actually matters
async function safeFetch(startUrl) {
  let target = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { records } = await resolveAndValidate(target);
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup(records) } });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await undiciFetch(target, { redirect: 'manual', signal: controller.signal, dispatcher });
    } catch (err) {
      dispatcher.close().catch(() => {}); // fetch itself failed, so nobody downstream owns this dispatcher
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return { res, dispatcher };
      try { await res.body?.cancel(); } catch {} // done with this hop's body, don't leave it dangling
      dispatcher.close().catch(() => {});
      target = new URL(loc, target).href;
      continue;
    }
    return { res, dispatcher }; // the caller streams the body, so it also owns closing this
  }
  throw new Error('Too many redirects');
}

// ---- health check, handy for reverse proxies and orchestrators --------------
app.get('/health', (_req, res) => res.type('text/plain').send('ok'));

// ---- the proxy endpoint itself ----------------------------------------------
app.get('/proxy', async (req, res) => {
  if (PROXY_DISABLED) return res.status(403).send('Remote URL loading is disabled.');

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const target = req.query.url;
  if (typeof target !== 'string') return res.status(400).send('Pass a "url" query parameter.');
  if (target.length > MAX_URL_LENGTH) return res.status(414).send('URL too long.');

  const retryAfter = takeProxyToken(ip);
  if (retryAfter) {
    res.set('Retry-After', String(retryAfter));
    return res.status(429).send('Rate limit exceeded. Slow down.');
  }

  if (inFlight >= MAX_CONCURRENT) {
    res.set('Retry-After', '5');
    return res.status(503).send('Server busy, retry shortly.');
  }
  const perIp = inFlightPerIp.get(ip) || 0;
  if (perIp >= MAX_CONCURRENT_PER_IP) {
    res.set('Retry-After', '5');
    return res.status(429).send('Too many concurrent requests.');
  }

  inFlight++;
  inFlightPerIp.set(ip, perIp + 1);
  const started = Date.now();
  let reader = null;
  let dispatcher = null;

  try {
    const fetched = await safeFetch(target);
    const upstream = fetched.res;
    dispatcher = fetched.dispatcher;
    if (!upstream.ok) {
      return res.status(upstream.status >= 400 ? upstream.status : 502)
        .send(`Upstream responded ${upstream.status}.`);
    }

    // strip any "; charset=..." or codecs parameter before matching
    const type = (upstream.headers.get('content-type') || 'application/octet-stream')
      .split(';')[0].trim();
    if (!ALLOWED_TYPE_RE.test(type)) {
      return res.status(415).send(`That URL isn't a video (it's ${type.slice(0, 80)}).`);
    }

    const declared = Number(upstream.headers.get('content-length') || 0);
    if (declared && declared > MAX_BYTES) {
      return res.status(413).send('Remote file exceeds size limit.');
    }

    // the global CSP gets swapped for a locked-down sandbox here, so even if
    // someone opens a proxied response directly in a tab it can't run anything
    // in our origin. no Access-Control-Allow-Origin on purpose: the page is
    // same-origin, and other sites have no business using our bandwidth
    res.set('Content-Type', type);
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('Cache-Control', 'no-store');
    // pass the length on so the page can show real download progress. fetch
    // decompresses on the fly, so a gzipped response's length would be the
    // compressed size and truncate the body. only forward it when it's raw
    if (declared && !upstream.headers.get('content-encoding')) {
      res.set('Content-Length', String(declared));
    }

    if (!upstream.body) return res.end();

    // stream with a hard byte cap and a whole-request deadline, and respect the
    // client's backpressure, so neither a huge/endless upstream nor a slow
    // reader can eat all our memory. the byte cap also kills gzip bombs, since
    // it counts bytes after decompression as they arrive
    reader = upstream.body.getReader();
    let total = 0;
    for (;;) {
      if (Date.now() - started > STREAM_DEADLINE_MS) { await reader.cancel(); return res.destroy(); }
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) { await reader.cancel(); return res.destroy(); }
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once('drain', resolve)); // backpressure
      }
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(502).send(`Proxy error: ${err.message}`);
    else res.destroy();
  } finally {
    try { reader && reader.cancel(); } catch {}
    if (dispatcher) dispatcher.close().catch(() => {});
    inFlight = Math.max(0, inFlight - 1);
    const n = (inFlightPerIp.get(ip) || 1) - 1;
    if (n <= 0) inFlightPerIp.delete(ip); else inFlightPerIp.set(ip, n);
  }
});

// ---------------------------------------------------------------------------
// youtube sections
// ---------------------------------------------------------------------------
// a YouTube stream can't be read into a canvas from the browser (no CORS on
// googlevideo, and the embed is a cross-origin iframe), so this is the one
// place we give up on doing the work client-side. to keep that surface
// small: the client only ever sends an 11-character video id and two numbers,
// we build the watch URL ourselves, and yt-dlp runs with no shell, no config
// files, no plugins, and a throwaway HOME. passing a user URL straight to
// yt-dlp would be an SSRF hole, since its generic extractor fetches anything
const YT_DISABLED = /^(1|true|yes)$/i.test(process.env.DISABLE_YOUTUBE || '');
const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';
const YT_COOKIES = process.env.YT_COOKIES || '';                           // Netscape cookies.txt, for bot checks
const YT_MAX_SECTION_S = Number(process.env.YT_MAX_SECTION_S) || 120;      // longest window one request can pull
const YT_MAX_HEIGHT = Number(process.env.YT_MAX_HEIGHT) || 720;            // px. a GIF never needs more
const YT_MAX_BYTES = Number(process.env.YT_MAX_BYTES) || 200 * 1024 * 1024;
const YT_TIMEOUT_MS = Number(process.env.YT_TIMEOUT_MS) || 180000;         // whole yt-dlp run, then SIGKILL
const YT_RATE_BURST = Number(process.env.YT_RATE_BURST) || 6;              // sections / IP
const YT_RATE_REFILL = Number(process.env.YT_RATE_REFILL) || 1 / 20;       // one more every 20 s
const YT_MAX_CONCURRENT = Number(process.env.YT_MAX_CONCURRENT) || 2;      // global yt-dlp processes
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// a home server runs other things too (media server, backups, whatever else
// is on the box), and yt-dlp/ffmpeg are the only spawned processes heavy
// enough to matter. numEnv lets 0 mean "explicitly disabled" rather than
// falling through to the default the way `Number(x) || def` would
function numEnv(name, def) {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const v = Number(raw);
  return Number.isFinite(v) ? v : def;
}
const YT_LOAD_FACTOR = numEnv('YT_LOAD_FACTOR', 1.5);   // refuse new fetches above loadavg > cpus * this. 0 disables
const YT_NICE_LEVEL = process.env.YT_NICE_LEVEL === 'off' ? null : numEnv('YT_NICE_LEVEL', 15); // 0-19, higher is kinder
const YT_MIN_FREE_BYTES = numEnv('YT_MIN_FREE_BYTES', 1024 * 1024 * 1024); // headroom required beyond one section's worst case

// nice/ionice are optional. spawnSync's one blocking call at startup beats
// discovering they're missing mid-fetch and failing every request
const HAS_NICE = YT_NICE_LEVEL !== null && !spawnSync('nice', ['--version'], { stdio: 'ignore' }).error;
const HAS_IONICE = YT_NICE_LEVEL !== null && !spawnSync('ionice', ['-h'], { stdio: 'ignore' }).error;

// wraps a command so it runs at low CPU and I/O priority, so a section cut
// can't starve whatever else the box is doing. nice/ionice exec() into the
// real command rather than forking, so the pid (and the process group used
// for detached kills) still belongs to the process we actually spawned
function withNiceness(cmd, args) {
  if (HAS_IONICE) return ['ionice', ['-c3', 'nice', '-n', String(YT_NICE_LEVEL), '--', cmd, ...args]];
  if (HAS_NICE) return ['nice', ['-n', String(YT_NICE_LEVEL), '--', cmd, ...args]];
  return [cmd, args];
}

// true when the 1-minute load average is already past what the box has
// cores for. checked before a fetch starts, not after, since the point is to
// not pile on rather than to notice once things are already bad
function systemTooBusy() {
  if (YT_LOAD_FACTOR <= 0) return false;
  return os.loadavg()[0] > Math.max(1, os.cpus().length) * YT_LOAD_FACTOR;
}

// a section download plus its remux can briefly need up to two copies on
// disk. checked against the temp dir's filesystem before we commit to a
// fetch, so a long run of big sections can't fill the disk the OS lives on
async function hasEnoughDiskSpace() {
  if (typeof fs.promises.statfs !== 'function') return true; // older Node: can't check, don't block on it
  try {
    const st = await fs.promises.statfs(os.tmpdir());
    return st.bavail * st.bsize > YT_MAX_BYTES * 2 + YT_MIN_FREE_BYTES;
  } catch {
    return true; // a failed check shouldn't itself be the reason a fetch is refused
  }
}

// yt-dlp or the server can die mid-fetch (OOM killer, a restart, a crash)
// and skip the `finally` block that would normally clean up. those leftover
// clipstation-* dirs never come back on their own, so unlike everything else
// here this runs whether or not a single request goes wrong: it's the one
// thing standing between a crash loop and a slowly full disk
const ORPHAN_MAX_AGE_MS = 60 * 60 * 1000; // an hour is well past any real fetch's timeout
async function sweepOrphanTempDirs() {
  let entries;
  try { entries = await fs.promises.readdir(os.tmpdir()); } catch { return; }
  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith('clipstation-')) continue;
    const full = path.join(os.tmpdir(), name);
    try {
      const st = await fs.promises.stat(full);
      if (now - st.mtimeMs > ORPHAN_MAX_AGE_MS) {
        await fs.promises.rm(full, { recursive: true, force: true });
        console.warn(`youtube: cleaned up an orphaned temp dir from a previous run: ${name}`);
      }
    } catch { /* gone or unreadable, either way there's nothing left to clean up */ }
  }
}
sweepOrphanTempDirs();
setInterval(sweepOrphanTempDirs, 30 * 60 * 1000).unref();

// H.264 first because every browser decodes it (Safari is patchy on VP9 and
// AV1), then VP9, then whatever's left. video only: a GIF has no sound, and
// skipping the audio makes the fetch smaller and quicker. HLS (m3u8) formats
// are excluded on purpose: ffmpeg can't seek into them for a section cut and
// hands back an empty file every time, and YouTube mixes them into the list
// for some clients. the last fallback allows anything, and an empty result
// from it still gets caught by probeClip
const YT_FORMAT = process.env.YT_FORMAT || [
  `bv*[height<=${YT_MAX_HEIGHT}][vcodec^=avc1][protocol!*=m3u8]`,
  // YouTube labels VP9 as vp9 on its https streams and vp09 on HLS ones
  `bv*[height<=${YT_MAX_HEIGHT}][vcodec~='^vp0?9'][protocol!*=m3u8]`,
  `bv*[height<=${YT_MAX_HEIGHT}][protocol!*=m3u8]`,
  `b[height<=${YT_MAX_HEIGHT}]`,
].join('/');

const takeYtToken = makeRateLimiter(YT_RATE_BURST, YT_RATE_REFILL);
const ytInFlightPerIp = new Map();
let ytInFlight = 0;

// checked once at startup so the page can say "not installed" up front
// instead of failing after someone's picked their section
let ytStatus = { enabled: false, reason: 'still checking for yt-dlp' };
if (YT_DISABLED) {
  ytStatus = { enabled: false, reason: 'YouTube fetching is turned off on this server' };
} else {
  const probe = spawn(YTDLP_PATH, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  probe.stdout.on('data', (d) => { out += d; });
  probe.on('error', () => {
    ytStatus = { enabled: false, reason: `yt-dlp isn't installed on this server (looked for "${YTDLP_PATH}")` };
    console.warn(`youtube: ${ytStatus.reason}`);
  });
  probe.on('close', (code) => {
    if (code !== 0) return;
    ytStatus = { enabled: true, version: out.trim() };
    console.log(`youtube: yt-dlp ${ytStatus.version}, ${YT_MAX_SECTION_S}s max section, ${YT_MAX_HEIGHT}p cap`);
    console.log(`youtube: niceness ${HAS_IONICE ? 'ionice+nice' : HAS_NICE ? 'nice' : 'unavailable'}, `
      + `load gate ${YT_LOAD_FACTOR > 0 ? `loadavg > cpus x ${YT_LOAD_FACTOR}` : 'off'}`);
  });
}

// the stderr lines people actually hit, turned into something readable. the
// raw output still goes to the server log
function explainYtError(stderr) {
  if (/confirm you.re not a bot|Sign in to confirm/i.test(stderr)) {
    return [503, 'YouTube is asking this server to prove it isn\'t a bot. the admin needs to set YT_COOKIES'];
  }
  if (/Private video/i.test(stderr)) return [403, 'That video is private. unlisted works, private doesn\'t'];
  if (/age|inappropriate/i.test(stderr) && /sign in/i.test(stderr)) {
    return [403, 'That video is age-restricted, which needs YT_COOKIES on the server'];
  }
  if (/Requested format is not available/i.test(stderr)) {
    return [502, "YouTube didn't offer a video format we can cut for that video"];
  }
  if (/unavailable|not available|been removed/i.test(stderr)) return [404, 'YouTube says that video is unavailable'];
  if (/larger than max-filesize/i.test(stderr)) return [413, 'That section is too big. pick a shorter one'];
  const last = stderr.trim().split('\n').pop() || 'unknown error';
  return [502, `yt-dlp failed: ${last.replace(/^ERROR:\s*/, '').slice(0, 200)}`];
}

// runs one of the ffmpeg tools with a hard timeout, no shell, and output
// capped so a chatty failure can't balloon memory
function runTool(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const [wcmd, wargs] = withNiceness(cmd, args);
    const p = spawn(wcmd, wargs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout = (stdout + d).slice(-4096); });
    p.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4096); });
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
    p.on('error', () => { clearTimeout(timer); resolve({ code: -1, stdout, stderr }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// a stream-copied cut can't start mid-GOP, and where the file ends up
// starting depends on the codec and container:
//   H.264 in mp4: pre-roll hidden behind an edit list, time 0 is the frame
//     you asked for
//   VP9 in webm: starts at the keyframe BEFORE the cut, so seconds early
//   VP9/AV1 in mp4: no edit list, ffmpeg drops up to the next keyframe and
//     the first frame sits seconds late
// what holds in every case is that the cut ENDS where we asked. so after
// rebasing any late start to 0, the file's duration tells us where it
// begins: lead = requested span - duration. positive means the clip starts
// after `start`, negative before. the page shifts the stoppers by it, which
// keeps them on the moment you picked on the YouTube timeline

// what's in the file yt-dlp handed back. hasVideo is false for the empty
// shell a flaky googlevideo response leaves behind
async function probeClip(file, { cwd, env }) {
  const probe = await runTool('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name:format=start_time,duration', '-of', 'json', file,
  ], { cwd, env, timeoutMs: 15000 });
  try {
    const info = JSON.parse(probe.stdout);
    const f = info.format || {};
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
    return { hasVideo: !!(info.streams && info.streams.length), start: num(f.start_time) || 0, duration: num(f.duration) };
  } catch {
    // ffprobe missing or choked. assume the file's fine and unshifted rather
    // than failing a fetch that probably worked
    return { hasVideo: true, start: 0, duration: NaN };
  }
}

const LEAD_NOISE_S = 0.05; // under this it's frame rounding, not a keyframe offset

async function normaliseStart(file, probe, span, { cwd, env }) {
  let out = file;
  if (probe.start > 0.02) {
    const rebased = path.join(cwd, `rebased${path.extname(file)}`);
    const remux = await runTool('ffmpeg', [
      '-v', 'error', '-nostdin', '-y', '-i', file, '-map', '0:v:0', '-c', 'copy', rebased,
    ], { cwd, env, timeoutMs: 60000 });
    // if the remux fails we still send the original. browsers that rebase
    // to 0 themselves will line up anyway, the rest end up off by the lead
    if (remux.code === 0 && fs.existsSync(rebased)) out = rebased;
  }
  const lead = Number.isFinite(probe.duration) ? span - probe.duration : probe.start;
  return { file: out, lead: Math.abs(lead) < LEAD_NOISE_S ? 0 : lead };
}

app.get('/yt/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ...ytStatus, maxSectionS: YT_MAX_SECTION_S });
});

app.get('/yt/clip', async (req, res) => {
  if (!ytStatus.enabled) return res.status(503).send(ytStatus.reason);

  const { id } = req.query;
  const start = Number(req.query.start);
  const end = Number(req.query.end);
  if (typeof id !== 'string' || !YT_ID_RE.test(id)) return res.status(400).send('Bad video id.');
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    return res.status(400).send('Bad start/end.');
  }
  // a hair of slack so float rounding on the client can't trip the cap
  if (end - start > YT_MAX_SECTION_S + 0.5) {
    return res.status(413).send(`Sections are capped at ${YT_MAX_SECTION_S} s.`);
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const retryAfter = takeYtToken(ip);
  if (retryAfter) {
    res.set('Retry-After', String(retryAfter));
    return res.status(429).send(`Too many sections too fast. try again in ${retryAfter} s.`);
  }
  if (systemTooBusy()) {
    res.set('Retry-After', '20');
    return res.status(503).send("This server's busy with something else right now. try again shortly.");
  }
  // this await has to happen before we so much as look at ytInFlight below.
  // an earlier version checked ytInFlight, then awaited here, then
  // incremented ytInFlight - which left a gap a burst of concurrent requests
  // could all slip through together, since none of them had incremented yet
  // by the time the next one ran its own check. with the only await moved up
  // here, the check-then-increment block below is one uninterrupted
  // synchronous run per request, same as it was before this existed
  if (!(await hasEnoughDiskSpace())) {
    return res.status(507).send("The server's short on disk space right now. try again once there's more room.");
  }

  if (ytInFlight >= YT_MAX_CONCURRENT) {
    res.set('Retry-After', '10');
    return res.status(503).send('The server is busy fetching other sections. retry shortly.');
  }
  const perIp = ytInFlightPerIp.get(ip) || 0;
  if (perIp >= 1) return res.status(429).send('Wait for your other section to finish.');

  ytInFlight++;
  ytInFlightPerIp.set(ip, perIp + 1);
  let tmp = null;
  let child = null;
  let finished = false;

  // detached so the kill takes out the ffmpeg yt-dlp spawns as well, not just
  // yt-dlp itself. otherwise a cancelled fetch leaves ffmpeg downloading on
  const killChild = () => {
    if (!child || child.exitCode !== null) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  };
  res.on('close', () => { if (!finished) killChild(); });

  try {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clipstation-'));
    const args = [
      '--ignore-config', '--no-plugin-dirs', '--no-cache-dir',
      '--no-playlist', '--no-mtime', '--no-progress', '--no-warnings', '--quiet',
      '--match-filters', '!is_live',
      // yt-dlp needs a JS runtime for YouTube's player challenges. we're
      // already running on one, so point it at this node rather than asking
      // every deploy to install deno
      '--js-runtimes', `node:${process.execPath}`,
      '--socket-timeout', '15',
      '--max-filesize', String(YT_MAX_BYTES),
      '-f', YT_FORMAT,
      '--download-sections', `*${start.toFixed(3)}-${end.toFixed(3)}`,
      '-o', path.join(tmp, 'clip.%(ext)s'),
      '--print', 'after_move:filepath',
    ];
    if (YT_COOKIES) args.push('--cookies', YT_COOKIES);
    args.push('--', `https://www.youtube.com/watch?v=${id}`);

    // a minimal env: PATH so it finds ffmpeg, and a HOME that's the empty
    // temp dir so nothing in the real home (config, plugins, cookies) leaks in
    const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: tmp, LANG: 'C.UTF-8' };
    const deadline = Date.now() + YT_TIMEOUT_MS;
    let timedOut = false;
    let code = 0;
    let stdout = '';
    let stderr = '';
    let emptyOutput = false;
    let file = null;
    let lead = 0;

    // googlevideo now and then 403s the first request for a stream. that
    // surfaces either as "ffmpeg exited with code 8" or, worse, as a clean
    // exit with a 257-byte mp4 holding no video at all. both work fine a
    // second later, so one retry from an empty temp dir covers it without
    // letting a real failure loop
    for (let attempt = 0; attempt < 2 && !file; attempt++) {
      if (attempt > 0) {
        console.warn(`youtube: ${id} ${start}-${end} ${emptyOutput ? 'came back empty' : 'ffmpeg failed'}, retrying once`);
        for (const f of await fs.promises.readdir(tmp)) {
          await fs.promises.rm(path.join(tmp, f), { force: true, recursive: true });
        }
      }
      stdout = '';
      stderr = '';
      emptyOutput = false;
      const [wcmd, wargs] = withNiceness(YTDLP_PATH, args);
      child = spawn(wcmd, wargs, { cwd: tmp, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-4096); });
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8192); });
      const timer = setTimeout(() => { timedOut = true; killChild(); }, Math.max(0, deadline - Date.now()));
      code = await new Promise((resolve) => {
        child.on('error', () => resolve(-1));
        child.on('close', resolve);
      });
      clearTimeout(timer);
      if (timedOut || res.destroyed) break;
      if (code !== 0) {
        if (/ffmpeg exited/i.test(stderr)) continue;
        break;
      }

      // trust the path yt-dlp printed only if it's really inside our temp dir
      const printed = path.resolve(stdout.trim().split('\n').pop() || '');
      if (!printed.startsWith(tmp + path.sep) || !fs.existsSync(printed)) break;
      const probe = await probeClip(printed, { cwd: tmp, env });
      if (!probe.hasVideo) { emptyOutput = true; continue; }
      ({ file, lead } = await normaliseStart(printed, probe, end - start, { cwd: tmp, env }));
    }
    if (res.destroyed) return;

    if (!file) {
      if (code !== 0) console.warn(`youtube: ${id} ${start}-${end} exited ${code}: ${stderr.trim().slice(-500)}`);
      if (timedOut) return res.status(504).send('Fetching that section took too long.');
      if (code !== 0) {
        const [status, msg] = explainYtError(stderr);
        return res.status(status).send(msg);
      }
      if (emptyOutput) return res.status(502).send('YouTube sent back an empty section twice. try again in a moment.');
      return res.status(422).send('YouTube gave us nothing for that section (live streams aren\'t supported).');
    }
    if (res.destroyed) return;
    const { size } = await fs.promises.stat(file);
    if (size > YT_MAX_BYTES) return res.status(413).send('That section is too big. pick a shorter one.');

    res.set('Content-Type', file.endsWith('.webm') ? 'video/webm' : 'video/mp4');
    res.set('Content-Length', String(size));
    res.set('X-Clip-Lead', lead.toFixed(3));
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('Cache-Control', 'no-store');
    await new Promise((resolve) => {
      const stream = fs.createReadStream(file);
      stream.on('error', () => { res.destroy(); resolve(); });
      res.on('close', resolve);
      stream.pipe(res);
    });
    finished = true;
  } catch (err) {
    if (!res.headersSent) res.status(500).send(`Couldn't fetch that section: ${err.message}`);
  } finally {
    finished = true;
    killChild();
    ytInFlight = Math.max(0, ytInFlight - 1);
    const n = (ytInFlightPerIp.get(ip) || 1) - 1;
    if (n <= 0) ytInFlightPerIp.delete(ip); else ytInFlightPerIp.set(ip, n);
    if (tmp) fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Clip Station -> http://${shown}:${PORT}`);
  console.log(`Serving static files from: ${PUBLIC_DIR}`);
  if (process.env.TRUST_PROXY) console.log(`trust proxy: ${app.get('trust proxy')}`);
  console.log(PROXY_DISABLED
    ? 'proxy: DISABLED (remote URL loading off)'
    : `proxy: on, ${RL_BURST} burst + ${RL_REFILL_PER_SEC}/s per IP, ${MAX_CONCURRENT_PER_IP}/${MAX_CONCURRENT} concurrent, ${(MAX_BYTES / 1048576).toFixed(0)}MB cap`);
});
