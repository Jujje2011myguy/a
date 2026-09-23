/**
 * Reverse proxy for poki.com, deployed as a Cloudflare Worker.
 *
 * How it works:
 * - Every request to your Worker's URL (e.g. https://yt.yourname.workers.dev/)
 *   is forwarded to the real poki.com, with the response streamed back to you.
 * - Because the request originates from Cloudflare's network, a network that only
 *   blocks poki.com directly will still let you reach your Worker's own domain.
 * - HTML/CSS/JS responses have their internal links rewritten so that further
 *   navigation also stays inside the proxy.
 *
 * Limitations (read before relying on this):
 * - Poki serves game assets from separate CDN domains (img.poki.com,
 *   game-cdn.poki.com, etc.). This proxy forwards those too so games load
 *   properly, but the asset host list may need updating over time if Poki
 *   changes its CDN setup.
 * - Logging into an account through this proxy is not recommended/supported.
 * - This does not hide who's running the Worker from Cloudflare/Poki — it only
 *   changes which hostname your local network sees.
 * - Only use this on networks/accounts where you're actually allowed to bypass
 *   the restriction (e.g. your own homelab, or where policy explicitly permits it).
 */

function matchesUpstream(hostname) {
  return hostname.endsWith("poki.com");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Path-based routing: /v/<target-host>/<rest> lets us proxy the extra
    // CDN subdomains that poki.com's HTML references.
    let targetHost = "poki.com";
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
    upstreamHeaders.set("Referer", "https://poki.com/");
    upstreamHeaders.set("Origin", "https://poki.com");
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
    // through the proxy instead of leaking the real poki.com URL.
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

    // Only rewrite text-based bodies; stream everything else (games, images) as-is.
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
    const u = new URL(link, "https://poki.com");
    if (matchesUpstream(u.hostname)) {
      if (u.hostname === "poki.com" || u.hostname === "www.poki.com") {
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
  // Rewrite absolute references to poki.com and its subdomains so subsequent
  // requests (images, scripts, game assets) also route through the proxy.
  return text
    .replace(/https:\/\/(www\.)?poki\.com/g, proxyOrigin)
    .replace(/https:\/\/([\w-]+)\.poki\.com/g, (m, sub) => `${proxyOrigin}/v/${sub}.poki.com`);
}
