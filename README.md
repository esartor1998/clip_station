# Clip Station

Trim a video in the browser and turn the selection into a GIF. Open a file,
drag a video in, or paste a link (YouTube included, unlisted too), then drag
the two stoppers on the timeline to pick the start and end. The video is
decoded and the GIF is built right in your browser with gifenc, so nothing
gets uploaded.

## What it supports

- whatever video your browser can decode: mp4 (H.264) and webm everywhere,
  mov/mkv/HEVC depending on the browser and OS
- file picker, drag-drop, and remote URLs (fetched through the server's proxy)
- YouTube links (watch, youtu.be, shorts, live, embed, with or without `t=`):
  browse the whole thing in an embedded player, then fetch only the section
  you picked (see below)
- a zoomable timeline, so a 3 hour video is still workable
- simple view (size, smoothness, quality presets) and an **advanced** view
  (exact width, frame rate, colour count, shared or per-frame palette,
  playback speed, loop count)
- boomerang (forward then backward) loops

## Run

```bash
npm install
npm start          # http://localhost:4183
```

YouTube needs yt-dlp and ffmpeg on the server. yt-dlp solves YouTube's
player challenges with a JavaScript runtime; the server points it at the Node
it's already running on, so there's no Deno to install:

```bash
sudo apt install ffmpeg
python3 -m venv .venv && .venv/bin/pip install -U 'yt-dlp[default]'
YTDLP_PATH=.venv/bin/yt-dlp npm start
```

Without yt-dlp everything else works, and YouTube links still open for
browsing; the panel says why fetching is off.

### YouTube

Paste a YouTube link and it opens in the embedded player (via
youtube-nocookie), driven by the same dock: play, scrub, stoppers, loop. The
embed can't hand over pixels, so a GIF can't be made from it directly.
Instead:

1. find the moment and drop the stoppers roughly around it. on a long video,
   zoom the timeline with the wheel (or `z` to jump to the selection)
2. **Fetch section**. the server pulls just that window, plus 2 s either side,
   capped at `YT_MAX_SECTION_S` (120 s by default). a 10 s section usually
   takes 5-10 s
3. the section opens as a normal local video with the stoppers where you left
   them. fine-trim and make the GIF as usual. the GIF's filename and the clip
   readout use the times from the full video
4. **back to the full video** returns to the YouTube timeline with your
   selection intact, ready for the next clip

The full video is never downloaded, and nothing from it goes through the GIF
encoder except the section you fetched.

### Controls

| Key | Does |
|-----|------|
| `space` | play / pause |
| `i` / `o` | move the start / end stopper to the playhead |
| `left` / `right` | step about a frame (`shift` for 1 s) |
| `l` | toggle looping inside the selection |
| `z` | zoom the timeline to the selection / back to the whole video |
| `m` | mute / unmute |
| `esc` | cancel an export, or close the result |

Click or drag on the timeline to scrub. Drag a stopper to move it (the video
previews that frame as you go), or drag the highlighted range between them to
slide the whole selection. A focused stopper also takes the arrow keys. The
mouse wheel over the timeline zooms around the pointer, and a sideways swipe
or `shift` + wheel pans. While zoomed, playback pages the view along.

## Configuration (env vars)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `4183` | port to listen on |
| `HOST` | `0.0.0.0` | bind address. `0.0.0.0` lets a reverse proxy reach it |
| `TRUST_PROXY` | *(unset)* | set behind a proxy so Express reads `X-Forwarded-*` (needed for per-IP rate limiting). `1`, `true`, or a subnet. leave unset when exposed directly |
| `DISABLE_PROXY` | *(unset)* | set to `1` to turn off remote URL loading entirely (local files still work) |
| `PROXY_MAX_BYTES` | `157286400` | max bytes streamed per video (150 MB) |
| `PROXY_RATE_BURST` | `6` | per-IP burst allowance |
| `PROXY_RATE_REFILL` | `0.1` | per-IP sustained requests/sec after the burst is spent |
| `PROXY_MAX_CONCURRENT` | `8` | global cap on in-flight upstream fetches |
| `PROXY_MAX_CONCURRENT_PER_IP` | `2` | per-IP cap on in-flight fetches |
| `PROXY_CONNECT_TIMEOUT_MS` | `8000` | time-to-headers timeout per hop |
| `PROXY_STREAM_TIMEOUT_MS` | `90000` | whole-request deadline including streaming |

| `DISABLE_YOUTUBE` | *(unset)* | set to `1` to turn off YouTube fetching (links still open for browsing) |
| `YTDLP_PATH` | `yt-dlp` | the yt-dlp binary |
| `YT_COOKIES` | *(unset)* | path to a Netscape `cookies.txt`, for when YouTube bot-checks the server |
| `YT_MAX_SECTION_S` | `120` | longest window one fetch can pull, padding included |
| `YT_MAX_HEIGHT` | `720` | resolution cap for fetched sections |
| `YT_MAX_BYTES` | `209715200` | size cap per section (200 MB) |
| `YT_TIMEOUT_MS` | `180000` | whole yt-dlp run, then it's killed |
| `YT_RATE_BURST` | `6` | per-IP section burst |
| `YT_RATE_REFILL` | `0.05` | per-IP sections/sec after the burst (one per 20 s) |
| `YT_MAX_CONCURRENT` | `2` | global cap on running yt-dlp processes (per IP it's always 1) |
| `YT_FORMAT` | *(see server.js)* | yt-dlp format selector override. the default prefers H.264, then VP9, video only, no HLS |
| `YT_LOAD_FACTOR` | `1.5` | refuse a new fetch while the 1-minute load average is past cpu count x this. `0` disables |
| `YT_NICE_LEVEL` | `15` | niceness (0-19) for yt-dlp/ffmpeg, so a fetch doesn't crowd out other things running on the box. `off` disables |
| `YT_MIN_FREE_BYTES` | `1073741824` | free space required on the temp dir's disk (beyond one section's worst case) before a fetch starts |

`GET /health` returns `200 ok` for health checks.

## Behind a reverse proxy

Works at a domain root or at a sub-path (the proxy is fetched with a relative
path). Redirect the slash-less form of a sub-path, and run with
`TRUST_PROXY=1`. Raise the proxy's body/timeout limits if you raise
`PROXY_MAX_BYTES`.

### nginx: sub-path

```nginx
location = /clip-station { return 301 /clip-station/; }   # enforce trailing slash
location /clip-station/ {
    proxy_pass http://127.0.0.1:4183/;      # trailing slash strips the prefix
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
}
```

### Caddy: sub-path

```
example.com {
    redir /clip-station /clip-station/
    handle_path /clip-station/* {
        reverse_proxy 127.0.0.1:4183
    }
}
```

## Notes and limits

- frames are read by seeking a hidden copy of the video to each timestamp, so
  export speed depends on how fast your browser seeks that codec. long-GOP
  files (screen recordings, some phone video) seek slowly
- a GIF is capped at 600 frames. the panel tells you when a selection is over
  and what to change
- the arrow-key step assumes 30 fps, since a `<video>` element won't report
  the source's real frame rate
- GIF delays are whole centiseconds, so frame rates snap to 100/n (50, 33.3,
  25, 20, 16.7, 14.3 ...). browsers clamp anything faster than 50 fps
- no cropping yet: the GIF always covers the full frame, scaled to the width
  you pick (never upscaled)
- a URL load is held fully in memory before playback starts, which is what
  keeps the canvas untainted. that's why the size cap exists
- YouTube fetches cut without re-encoding, so the clip starts on a keyframe up
  to a few seconds either side of where you asked. the server measures the
  offset and the page shifts the stoppers to match, which is why they land on
  the right frame. that's checked against H.264 and VP9; AV1 goes through the
  same path but is untested
- the embed needs "Allow embedding" on in YouTube Studio (it's on by default,
  unlisted included). private videos and live streams don't work
- YouTube sometimes bot-checks datacenter IPs ("Sign in to confirm you're not
  a bot"). a home server is usually fine; on a VPS you may need `YT_COOKIES`
  from a throwaway account
- yt-dlp is deliberately not pinned. YouTube changes often enough that a
  pinned yt-dlp stops working within weeks, so keep it updated
  (`pip install -U 'yt-dlp[default]'`). tested with 2026.08.19
- YouTube's terms only allow downloading where they offer it or with the
  owner's permission. this is meant for clipping your own videos
- the timeline has no pinch-zoom on touchscreens yet. use Zoom sel and Fit
- a fetch is refused up front, before yt-dlp even starts, if the box is
  already under load or short on disk space. both are tunable (see
  `YT_LOAD_FACTOR` and `YT_MIN_FREE_BYTES`) and just try again once the
  earlier reason has passed
- a temp dir survives on disk only for the length of one fetch; anything
  left behind by a crash gets swept up automatically within the hour
- gifenc is loaded from jsDelivr at a pinned version. vendor it into
  `public/` and drop jsDelivr from the CSP in `server.js` for a CDN-free deploy
