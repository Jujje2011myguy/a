/**
 * Reverse proxy for YouTube, deployed as a Cloudflare Worker.
 *
 * How it works:
 * - Every request to your Worker's URL (e.g. https://yt.yourname.workers.dev/watch?v=xyz)
 *   is forwarded to the real youtube.com, with the response streamed back to you.
 * - Because the request originates from Cloudflare's network, a network that only
 *   blocks youtube.com directly will still let you reach your Worker's own domain.
 * - HTML/CSS/JS responses have their internal links rewritten (including
 *   protocol-relative and JSON-escaped URLs embedded in YouTube's page data)
 *   so further navigation and playback stay inside the proxy.
 * - Cookies are forwarded in both directions, scoped to your Worker's own
 *   domain, so YouTube sees a consistent anonymous session across requests
 *   instead of a brand new "visitor" on every click. This is what cuts down
 *   on repeated consent/verification interstitials.
 *
 * Limitations (read before relying on this):
 * - YouTube serves video/audio data from separate domains (googlevideo.com,
 *   ytimg.com, ggpht.com, etc.). This proxy also forwards those so playback works,
 *   but Google actively changes response formats and may rate-limit or block
 *   traffic that looks like a proxy. Expect occasional breakage.
 * - Logging into an actual Google account through this proxy is NOT supported
 *   and won't be made to work reliably — Google's device/session verification
 *   is specifically designed to detect and block this pattern. This proxy is
 *   for anonymous viewing only.
 * - This does not hide who's running the Worker from Cloudflare/Google — it only
 *   changes which hostname your local network sees.
 * - Only use this on networks/accounts where you're actually allowed to bypass
 *   the restriction (e.g. your own homelab, or where policy explicitly permits it).
 */

function matchesUpstream(hostname) {
  return (
    hostname.endsWith("youtube.com") ||
    hostname.endsWith("ytimg.com") ||
    hostname.endsWith("ggpht.com") ||
    hostname.endsWith("googlevideo.com")
  );
}

function canonicalHost(hostname) {
  // Normalize the various youtube.com subdomains to a single canonical one
  // so cookies/session state aren't fragmented across www/m/bare.
  if (hostname === "www.youtube.com" || hostname === "youtube.com" || hostname === "m.youtube.com") {
    return "www.youtube.com";
  }
  return hostname;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight — answer locally, don't forward to YouTube.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    let targetHost = "www.youtube.com";
    let targetPath = url.pathname + url.search;

    // Path-based routing: /v/<target-host>/<rest> lets us proxy the extra
    // domains (video CDN, thumbnails) that youtube.com's HTML references.
    const vMatch = url.pathname.match(/^\/v\/([^/]+)(\/.*)?$/);
    if (vMatch) {
      targetHost = vMatch[1];
      targetPath = (vMatch[2] || "/") + url.search;
    }

    if (!matchesUpstream(targetHost)) {
      return new Response("Blocked host", { status: 403 });
    }

    targetHost = canonicalHost(targetHost);
    const upstreamUrl = `https://${targetHost}${targetPath}`;

    const upstreamHeaders = new Headers(request.headers);
    upstreamHeaders.set("Host", targetHost);
    upstreamHeaders.set("Referer", "https://www.youtube.com/");
    upstreamHeaders.set("Origin", "https://www.youtube.com");
    upstreamHeaders.delete("cookie");

    // Forward the browser's cookies (set by *this* proxy on earlier
    // responses) up to YouTube, so a session persists across requests
    // instead of looking like a fresh visitor every time.
    const incomingCookie = request.headers.get("cookie");
    if (incomingCookie) {
      upstreamHeaders.set("cookie", incomingCookie);
    }

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers: upstreamHeaders,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
        redirect: "manual",
      });
    } catch (err) {
      return new Response(`Upstream fetch failed: ${err.message}`, { status: 502 });
    }

    const contentType = upstreamResponse.headers.get("content-type") || "";
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.delete("content-security-policy");
    responseHeaders.delete("content-security-policy-report-only");
    responseHeaders.delete("x-frame-options");
    responseHeaders.delete("strict-transport-security");

    // Rewrite Set-Cookie so cookies land on the proxy's own domain, not
    // youtube.com (the browser would silently drop them otherwise), and
    // strip attributes that don't make sense cross-origin.
    if (typeof responseHeaders.getSetCookie === "function") {
      const setCookies = responseHeaders.getSetCookie();
      if (setCookies.length) {
        responseHeaders.delete("set-cookie");
        for (const cookie of setCookies) {
          const rewritten = cookie
            .replace(/;\s*[Dd]omain=[^;]*/g, "")
            .replace(/;\s*[Ss]ecure/g, "")
            .replace(/;\s*[Ss]ameSite=\w+/gi, "; SameSite=Lax");
          responseHeaders.append("set-cookie", rewritten);
        }
      }
    }

    // Follow redirects manually so we can rewrite the Location header back
    // through the proxy instead of leaking the real youtube.com URL.
    if ([301, 302, 303, 307, 308].includes(upstreamResponse.status)) {
      const loc = upstreamResponse.headers.get("location");
      if (loc) {
        responseHeaders.set("location", rewriteToProxy(loc, url.origin));
      }
      return new Response(null, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });
    }

    // Only rewrite text-based bodies; stream everything else (video, images) as-is.
    const isRewritable =
      contentType.includes("text/html") ||
      contentType.includes("javascript") ||
      contentType.includes("text/css") ||
      contentType.includes("application/json");

    if (isRewritable) {
      let body = await upstreamResponse.text();
      body = rewriteBody(body, url.origin);
      // Body was decoded by fetch() and re-encoded as plain text below, so
      // the original content-encoding/content-length headers no longer
      // describe it. Leaving them in place causes browsers to try to
      // gzip/brotli-decode an already-decoded body and fail.
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
      return new Response(body, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });
    }

    // Binary/streamed passthrough (video chunks, images, fonts). Range
    // requests are forwarded automatically since we copy request.headers,
    // and 206 Partial Content responses pass straight through here.
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  },
};

function rewriteToProxy(link, proxyOrigin) {
  try {
    const u = new URL(link, "https://www.youtube.com");
    if (matchesUpstream(u.hostname)) {
      const host = canonicalHost(u.hostname);
      if (host === "www.youtube.com") {
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
  // Escaped variant of the proxy origin for use inside JSON-string
  // replacements (e.g. embedded in ytInitialData / ytInitialPlayerResponse).
  const escapedOrigin = proxyOrigin.replace(/\//g, "\\/");

  return (
    text
      // Plain absolute URLs.
      .replace(/https:\/\/(www\.|m\.)?youtube\.com/g, proxyOrigin)
      .replace(/https:\/\/i\.ytimg\.com/g, `${proxyOrigin}/v/i.ytimg.com`)
      .replace(/https:\/\/([\w-]+\.)?googlevideo\.com/g, (m, sub) => `${proxyOrigin}/v/${sub || ""}googlevideo.com`)
      .replace(/https:\/\/(yt3|yt4)\.ggpht\.com/g, (m, sub) => `${proxyOrigin}/v/${sub}.ggpht.com`)
      // JSON-escaped URLs (\/\/ style), common inside inline <script> data blobs.
      .replace(/https:\\\/\\\/(www\.|m\.)?youtube\.com/g, escapedOrigin)
      .replace(/https:\\\/\\\/i\.ytimg\.com/g, `${escapedOrigin}\\/v\\/i.ytimg.com`)
      .replace(
        /https:\\\/\\\/([\w-]+\.)?googlevideo\.com/g,
        (m, sub) => `${escapedOrigin}\\/v\\/${sub || ""}googlevideo.com`
      )
      .replace(/https:\\\/\\\/(yt3|yt4)\.ggpht\.com/g, (m, sub) => `${escapedOrigin}\\/v\\/${sub}.ggpht.com`)
      // Protocol-relative URLs.
      .replace(/\/\/(www\.|m\.)?youtube\.com/g, proxyOrigin)
      .replace(/\/\/i\.ytimg\.com/g, `${proxyOrigin}/v/i.ytimg.com`)
  );
}
