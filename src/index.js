/**
 * Reverse proxy for YouTube, deployed as a Cloudflare Worker.
 *
 * How it works:
 * - Every request to your Worker's URL (e.g. https://yt.yourname.workers.dev/watch?v=xyz)
 *   is forwarded to the real youtube.com, with the response streamed back to you.
 * - Because the request originates from Cloudflare's network, a network that only
 *   blocks youtube.com directly will still let you reach your Worker's own domain.
 * - HTML/CSS/JS responses have their internal links rewritten so that further
 *   navigation also stays inside the proxy.
 *
 * Limitations (read before relying on this):
 * - YouTube serves video/audio data from separate domains (googlevideo.com,
 *   ytimg.com, ggpht.com, etc.). This proxy also forwards those so playback works,
 *   but Google actively changes response formats and may rate-limit or block
 *   traffic that looks like a proxy. Expect occasional breakage.
 * - Logging into a Google account through this proxy is not recommended/supported.
 * - This does not hide who's running the Worker from Cloudflare/Google — it only
 *   changes which hostname your local network sees.
 * - Only use this on networks/accounts where you're actually allowed to bypass
 *   the restriction (e.g. your own homelab, or where policy explicitly permits it).
 */

const UPSTREAM_HOSTS = [
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "i.ytimg.com",
  "yt3.ggpht.com",
  "yt4.ggpht.com",
  "googlevideo.com",
  "*.googlevideo.com",
];

function matchesUpstream(hostname) {
  return (
    hostname.endsWith("youtube.com") ||
    hostname.endsWith("ytimg.com") ||
    hostname.endsWith("ggpht.com") ||
    hostname.endsWith("googlevideo.com")
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Path-based routing: /v/<target-host>/<rest> lets us proxy the extra
    // domains (video CDN, thumbnails) that youtube.com's HTML references.
    let targetHost = "www.youtube.com";
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

    const upstreamHeaders = new Headers(request.headers);
    upstreamHeaders.set("Host", targetHost);
    upstreamHeaders.set("Referer", "https://www.youtube.com/");
    upstreamHeaders.set("Origin", "https://www.youtube.com");
    upstreamHeaders.delete("cookie"); // don't leak your Worker's own cookies upstream

    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
    });

    const contentType = upstreamResponse.headers.get("content-type") || "";
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.delete("content-security-policy");
    responseHeaders.delete("x-frame-options");

    // Follow redirects manually so we can rewrite the Location header back
    // through the proxy instead of leaking the real youtube.com URL.
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

    // Only rewrite text-based bodies; stream everything else (video, images) as-is.
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
  },
};

function rewriteToProxy(link, proxyOrigin) {
  try {
    const u = new URL(link, "https://www.youtube.com");
    if (matchesUpstream(u.hostname)) {
      if (u.hostname === "www.youtube.com" || u.hostname === "youtube.com" || u.hostname === "m.youtube.com") {
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
  // Rewrite absolute references to the known upstream hosts so subsequent
  // requests (images, scripts, video chunks) also route through the proxy.
  return text
    .replace(/https:\/\/(www\.|m\.)?youtube\.com/g, proxyOrigin)
    .replace(/https:\/\/i\.ytimg\.com/g, `${proxyOrigin}/v/i.ytimg.com`)
    .replace(/https:\/\/([\w-]+\.)?googlevideo\.com/g, (m, sub) => `${proxyOrigin}/v/${sub || ""}googlevideo.com`)
    .replace(/https:\/\/(yt3|yt4)\.ggpht\.com/g, (m, sub) => `${proxyOrigin}/v/${sub}.ggpht.com`);
}
