// ============================================================
//  cloudflare_worker_fallback.js
//
//  Deploy this as a Cloudflare Worker and bind it to:
//    api.g-741studio.com/*
//    stream.g-741studio.com/*
//
//  These two public hostnames now route to THIS WORKER (a Worker Route
//  in the dashboard), not directly to a tunnel. The Worker tries the
//  primary host first and only falls back to the standby host on
//  failure/5xx - so as long as the primary (NH) is up, 100% of traffic
//  goes there; the standby (OH) only ever answers real visitors when
//  NH genuinely can't. This is deliberately NOT "run cloudflared as a
//  replica of the same tunnel on both machines" - Cloudflare's own docs
//  say replica routing is geography-based with no priority guarantee
//  (https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/),
//  which could easily split live visitors across two independent UE5/
//  Wilbur sessions with separate lobby state - exactly what "prefer one
//  host, fall back to the other" is supposed to prevent, not cause.
//
//  Setup (Cloudflare dashboard, one-time):
//    1. Each host keeps its OWN named tunnel (its own tunnel ID/
//       credentials - do not share one tunnel's identity across two
//       machines). Give each an INTERNAL-only DNS hostname, e.g.:
//         nh-internal.g-741studio.com  -> primary host's tunnel
//         oh-internal.g-741studio.com  -> standby host's tunnel
//       (`cloudflared tunnel route dns <tunnel-name> <hostname>`)
//       These internal hostnames are also how you test a host in
//       isolation before it's ever handling real traffic - hit
//       nh-internal.g-741studio.com directly to check a freshly set up
//       host works, completely independent of what's currently live on
//       the public domain.
//    2. Workers & Pages -> this Worker -> Settings -> Variables ->
//       add PRIMARY_HOST and SECONDARY_HOST (plain text vars), set to
//       the two internal hostnames above.
//    3. Worker's Settings -> Triggers -> Add Route:
//         api.g-741studio.com/*
//         stream.g-741studio.com/*
//       (zone: g-741studio.com) - remove any direct CNAME-to-tunnel
//       DNS record for these two hostnames first, a Worker Route and a
//       proxied CNAME to the same name will fight each other.
// ============================================================

export default {
  async fetch(request, env) {
    const primary = env.PRIMARY_HOST;
    const secondary = env.SECONDARY_HOST;

    if (primary) {
      try {
        return await tryHost(request, primary);
      } catch (err) {
        // fall through to secondary
      }
    }
    if (secondary) {
      try {
        return await tryHost(request, secondary);
      } catch (err) {
        // fall through to the friendly error page
      }
    }
    return fallbackPage();
  },
};

async function tryHost(request, hostname) {
  const url = new URL(request.url);
  url.hostname = hostname;
  const forwarded = new Request(url, request);
  const response = await fetch(forwarded, { signal: AbortSignal.timeout(8000) });
  if (response.status >= 500) throw new Error(`origin ${hostname} returned ${response.status}`);
  return response;
}

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
