/**
 * Reverse proxy for blooket.com, deployed as a Cloudflare Worker.
 *
 * How it works:
 * - Every request to your Worker's URL (e.g. https://yt.yourname.workers.dev/)
 *   is forwarded to the real blooket.com, with the response streamed back to you.
 * - WebSocket connections (used for live game rounds / joining a game) are now
 *   proxied too, by forwarding the Upgrade request straight through to upstream.
 * - HTML/CSS/JS responses have their internal links rewritten (including ws://
 *   and wss:// URLs) so that further navigation and socket connections also
 *   stay inside the proxy.
 *
 * READ THIS BEFORE USING:
 * - Blooket sits behind Cloudflare itself. Requests from a Worker don't carry
 *   the TLS/browser fingerprint a normal visitor has, so Blooket's own
 *   anti-bot layer can serve a challenge page instead of the real site. If
 *   the page still won't load after this update, that's almost certainly why,
 *   and there's no reliable fix for it from inside a Worker.
 * - The regex-based link rewriting only catches URLs that appear as literal
 *   text in HTML/CSS/JS. Bundled/minified JS sometimes builds URLs at
 *   runtime (string concatenation, computed subdomains) which this proxy
 *   can't see or rewrite, so some requests may still leak straight to the
 *   real blooket.com and get blocked by the network you're trying to route
 *   around, or simply fail with a CORS error.
 * - Logging into an account through this proxy is not recommended/supported.
 * - This does not hide who's running the Worker from Cloudflare/Blooket — it
 *   only changes which hostname your local network sees.
 * - Only use this on networks/accounts where you're actually allowed to
 *   bypass the restriction. Many school and workplace networks block sites
 *   like this deliberately as a matter of policy, not by accident — check
 *   before relying on this, and don't use it to get around a restriction
 *   your school/employer would tell you no to if you asked directly.
 */

function matchesUpstream(hostname) {
  return hostname.endsWith("blooket.com");
}

// blooket.com (bare, no "www") 301-redirects to www.blooket.com. Fetching the
// bare domain by default caused the redirect loop: the Worker kept fetching
// the bare domain, getting redirected to www, collapsing that redirect back
// down to the same proxy URL, then fetching the bare domain again on the next
// request. Fetching the canonical host directly avoids that redirect entirely.
const ROOT_HOST = "www.blooket.com";

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request);
    } catch (err) {
      // Surface the real error instead of a bare, unhelpful 500 page.
      return new Response(`Proxy error: ${err && err.stack ? err.stack : err}`, {
        status: 500,
        headers: { "content-type": "text/plain" },
      });
    }
  },
};

async function handleRequest(request) {
    const url = new URL(request.url);

    // Path-based routing: /v/<target-host>/<rest> lets us proxy the extra
    // CDN/API/websocket subdomains that blooket.com's code references.
    let targetHost = ROOT_HOST;
    let targetPath = url.pathname + url.search;

    const vMatch = url.pathname.match(/^\/v\/([^/]+)(\/.*)?$/);
    if (vMatch) {
      targetHost = vMatch[1];
      targetPath = (vMatch[2] || "/") + url.search;
    }

    if (!matchesUpstream(targetHost)) {
      return new Response("Blocked host", { status: 403 });
    }

    const upstreamUrl = `https://${targetHost}${targetPath}`;

    // --- WebSocket upgrade: forward the request as-is and let the Workers
    // runtime proxy the socket. This is what makes "joining a live game"
    // possible, since Blooket's game rounds run over a socket connection.
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
      const wsHeaders = new Headers(request.headers);
      wsHeaders.set("Host", targetHost);
      wsHeaders.set("Origin", "https://blooket.com");
      const wsRequest = new Request(upstreamUrl, {
        method: request.method,
        headers: wsHeaders,
      });
      return fetch(wsRequest);
    }

    const upstreamHeaders = new Headers(request.headers);
    upstreamHeaders.set("Host", targetHost);
    upstreamHeaders.set("Referer", "https://blooket.com/");
    upstreamHeaders.set("Origin", "https://blooket.com");
    // Forward the visitor's cookies upstream so Blooket can maintain a
    // session. Dropping these was causing an infinite redirect loop: Blooket
    // kept trying to (re)set a session cookie on every request because it
    // never saw one coming back.

    // POST/PUT requests (like actually joining a game) forward a streaming
    // body. Cloudflare Workers require "duplex: half" whenever a streaming
    // body is passed to fetch(), or it throws immediately and you get a bare
    // 500 with no useful message — that was causing the join request to fail.
    const upstreamInit = {
      method: request.method,
      headers: upstreamHeaders,
      redirect: "manual",
    };
    if (!["GET", "HEAD"].includes(request.method)) {
      upstreamInit.body = request.body;
      upstreamInit.duplex = "half";
    }
    const upstreamResponse = await fetch(upstreamUrl, upstreamInit);
    console.log(upstreamUrl, upstreamResponse.status, upstreamResponse.headers.get("cf-mitigated"));

    const contentType = upstreamResponse.headers.get("content-type") || "";
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.delete("content-security-policy");
    responseHeaders.delete("x-frame-options");

    // Rewrite Set-Cookie so cookies are scoped to the proxy's own domain
    // instead of blooket.com (the browser silently drops a Domain= that
    // doesn't match the site it's actually visiting, which is what caused
    // the redirect loop).
    responseHeaders.delete("set-cookie");
    const setCookies =
      typeof upstreamResponse.headers.getSetCookie === "function"
        ? upstreamResponse.headers.getSetCookie()
        : upstreamResponse.headers.get("set-cookie")
        ? [upstreamResponse.headers.get("set-cookie")]
        : [];
    for (const cookie of setCookies) {
      responseHeaders.append("set-cookie", rewriteSetCookie(cookie));
    }

    // Follow redirects manually so we can rewrite the Location header back
    // through the proxy instead of leaking the real blooket.com URL.
    if ([301, 302, 303, 307, 308].includes(upstreamResponse.status)) {
      const loc = upstreamResponse.headers.get("location");
      if (loc) {
        const rewritten = rewriteToProxy(loc, url.origin);
        responseHeaders.set("location", rewritten);
      }
      return new Response(null, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });
    }

    // Only rewrite text-based bodies; stream everything else as-is.
    if (contentType.includes("text/html") || contentType.includes("javascript") || contentType.includes("text/css")) {
      let body = await upstreamResponse.text();
      body = rewriteBody(body, url.origin);
      return new Response(body, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
}

function rewriteSetCookie(setCookieHeader) {
  // Strip the Domain attribute (so the cookie becomes host-only and sticks
  // to the proxy's own domain) and force Path=/ so it's sent on every
  // proxied path, including /v/<subdomain>/... requests.
  let cookie = setCookieHeader.replace(/;\s*Domain=[^;]*/i, "");
  cookie = /;\s*Path=/i.test(cookie)
    ? cookie.replace(/;\s*Path=[^;]*/i, "; Path=/")
    : cookie + "; Path=/";
  return cookie;
}

function rewriteToProxy(link, proxyOrigin) {
  try {
    const u = new URL(link, "https://blooket.com");
    if (matchesUpstream(u.hostname)) {
      if (u.hostname === "blooket.com" || u.hostname === ROOT_HOST) {
        return `${proxyOrigin}${u.pathname}${u.search}`;
      }
      return `${proxyOrigin}/v/${u.hostname}${u.pathname}${u.search}`;
    }
    return link;
  } catch {
    return link;
  }
}

function rewriteBody(text, proxyOrigin) {
  const wsOrigin = proxyOrigin.replace(/^http/, "ws");

  // Rewrite absolute http(s) references to blooket.com and its subdomains so
  // subsequent requests (scripts, assets, API calls) also route through the proxy.
  let out = text
    .replace(/https:\/\/(www\.)?blooket\.com/g, proxyOrigin) // both variants collapse safely now that root fetches ROOT_HOST directly
    .replace(/https:\/\/([\w-]+)\.blooket\.com/g, (m, sub) => `${proxyOrigin}/v/${sub}.blooket.com`);

  // Rewrite ws(s):// references the same way, so socket connections
  // (game rounds, live updates) also route through the proxy.
  out = out
    .replace(/wss?:\/\/(www\.)?blooket\.com/g, wsOrigin)
    .replace(/wss?:\/\/([\w-]+)\.blooket\.com/g, (m, sub) => `${wsOrigin}/v/${sub}.blooket.com`);

  return out;
}
