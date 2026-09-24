# Clip Station

Trim a video in the browser and turn the selection into a GIF. Open a file,
drag a video in, or paste a link, then drag the two stoppers on the timeline to
pick the start and end. The video is decoded and the GIF is built right in
your browser with gifenc, so nothing gets uploaded.

## What it supports

- whatever video your browser can decode: mp4 (H.264) and webm everywhere,
  mov/mkv/HEVC depending on the browser and OS
- file picker, drag-drop, and remote URLs (fetched through the server's proxy)
- simple view (size, smoothness, quality presets) and an **advanced** view
  (exact width, frame rate, colour count, shared or per-frame palette,
  playback speed, loop count)
- boomerang (forward then backward) loops

## Run

```bash
npm install
npm start          # http://localhost:4183
```

### Controls

| Key | Does |
|-----|------|
| `space` | play / pause |
| `i` / `o` | move the start / end stopper to the playhead |
| `left` / `right` | step about a frame (`shift` for 1 s) |
| `l` | toggle looping inside the selection |
| `m` | mute / unmute |
| `esc` | cancel an export, or close the result |

Click or drag on the timeline to scrub. Drag a stopper to move it (the video
previews that frame as you go), or drag the highlighted range between them to
slide the whole selection. A focused stopper also takes the arrow keys.

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

`GET /health` returns `200 ok` for health checks.

### Server hardening

`/proxy` is the only server-side surface. Local files never touch the server.
It's the same approach as Rotation Station's proxy, tightened for video:

- **SSRF:** only `http(s)`; blocks private/loopback/link-local/CGNAT ranges
  (IPv4 + IPv6, incl. IPv4-mapped and bracketed literals); resolves DNS and
  checks every address; re-validates each redirect hop
- **Content type:** only `video/*` and the generic octet-stream types get
  relayed, so it can't be used as a general open proxy for HTML or scripts
- **Rate limit:** per-IP token bucket, sized for one request per video
- **Concurrency:** per-IP and global in-flight caps (`429`/`503`)
- **Size/time:** 150 MB streamed cap, connect and whole-request deadlines
- **Backpressure:** respects the client's read speed
- **Headers:** a strict Content-Security-Policy on every page, and proxied
  responses get `sandbox` so they can't run anything in our origin even if
  opened directly. no CORS header, so other sites can't borrow the proxy

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
- gifenc is loaded from jsDelivr at a pinned version. vendor it into
  `public/` and drop jsDelivr from the CSP in `server.js` for a CDN-free deploy
