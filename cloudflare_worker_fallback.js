// ============================================================
//  cloudflare_worker_fallback.js
//
//  Deploy this as a Cloudflare Worker and bind it to:
//    api.g-741studio.com/*
//    stream.g-741studio.com/*
//
//  Both hostnames route through the arkwiz-api Cloudflare Tunnel to the
//  host machine. When the tunnel is down (host offline, network drop),
//  Cloudflare's own edge normally renders its default 530 error page
//  directly - before any of our own code ever runs, since the request
//  never reaches our origin. This Worker sits in front of that: it tries
//  the real origin first, and only on failure/5xx swaps in a friendly
//  branded page with a Reload button instead of Cloudflare's default.
//
//  Deploy steps (Cloudflare dashboard):
//    1. Workers & Pages -> Create -> Create Worker
//    2. Paste this whole file into the editor, Deploy
//    3. Worker's Settings -> Triggers -> Add Route:
//         api.g-741studio.com/*
//         stream.g-741studio.com/*
//       (zone: g-741studio.com)
// ============================================================

export default {
  async fetch(request) {
    try {
      const response = await fetch(request, {
        signal: AbortSignal.timeout(8000),
      });
      if (response.status >= 500) {
        return fallbackPage();
      }
      return response;
    } catch (err) {
      return fallbackPage();
    }
  },
};

function fallbackPage() {
  return new Response(FALLBACK_HTML, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

const FALLBACK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ArchViz - Connection Lost</title>
<style>
  html, body {
    margin: 0; height: 100%;
    background: #080807;
    color: #ede9e2;
    font-family: 'DM Mono', 'Courier New', monospace;
    display: flex; align-items: center; justify-content: center;
    text-align: center;
  }
  .card { max-width: 340px; padding: 24px; }
  .title {
    font-family: Georgia, serif;
    font-size: 24px; font-weight: 300;
    color: #c8a96e;
    letter-spacing: 0.05em;
    margin-bottom: 12px;
  }
  .sub {
    font-size: 12px; line-height: 1.6;
    color: rgba(237,233,226,0.5);
    margin-bottom: 24px;
  }
  button {
    font-family: inherit;
    font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase;
    padding: 12px 28px;
    background: rgba(200,169,110,0.12);
    border: 0.5px solid #c8a96e;
    color: #c8a96e;
    border-radius: 2px;
    cursor: pointer;
  }
  button:active { background: rgba(200,169,110,0.25); }
  .hint { margin-top: 16px; font-size: 10px; color: rgba(237,233,226,0.25); }
</style>
</head>
<body>
  <div class="card">
    <div class="title">Connection Lost</div>
    <div class="sub">The demo host is temporarily unreachable. This usually resolves itself within a minute.</div>
    <button onclick="location.reload()">Reload</button>
    <div class="hint" id="hint"></div>
  </div>
  <script>
    // Light auto-retry so most visitors never need to press the button
    // themselves - checks in the background and reloads once it's back.
    let tries = 0;
    const hint = document.getElementById('hint');
    setInterval(async () => {
      tries++;
      if (hint) hint.textContent = 'Checking again... (' + tries + ')';
      try {
        const res = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
        if (res.status < 500) location.reload();
      } catch (e) {}
    }, 8000);
  </script>
</body>
</html>`;
