/**
 * Reverse proxy for garticphone.com, deployed as a Cloudflare Worker.
 *
 * How it works:
 * - Every request to your Worker's URL (e.g. https://yt.yourname.workers.dev/)
 *   is forwarded to the real garticphone.com, with the response streamed back to you.
 * - Because the request originates from Cloudflare's network, a network that only
 *   blocks garticphone.com directly will still let you reach your Worker's own domain.
 * - HTML/CSS/JS responses have their internal links rewritten so that further
 *   navigation also stays inside the proxy.
 *
 * Limitations (read before relying on this):
 * - Gartic Phone likely serves assets and websocket traffic from separate CDN/
 *   API subdomains. This proxy forwards subdomain requests too, but websocket
 *   connections (used for live multiplayer rounds) may not work correctly
 *   through a plain HTTP fetch-based proxy like this one — that's a real risk,
 *   not just a maintenance footnote.
 * - Logging into an account through this proxy is not recommended/supported.
 * - This does not hide who's running the Worker from Cloudflare/Gartic Phone —
 *   it only changes which hostname your local network sees.
 * - Only use this on networks/accounts where you're actually allowed to bypass
 *   the restriction (e.g. your own homelab, or where policy explicitly permits it).
 */

function matchesUpstream(hostname) {
  return hostname.endsWith("garticphone.com");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Path-based routing: /v/<target-host>/<rest> lets us proxy the extra
    // CDN/API subdomains that garticphone.com's HTML references.
    let targetHost = "garticphone.com";
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
    upstreamHeaders.set("Referer", "https://garticphone.com/");
    upstreamHeaders.set("Origin", "https://garticphone.com");
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
    // through the proxy instead of leaking the real garticphone.com URL.
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
  },
};

function rewriteToProxy(link, proxyOrigin) {
  try {
    const u = new URL(link, "https://garticphone.com");
    if (matchesUpstream(u.hostname)) {
      if (u.hostname === "garticphone.com" || u.hostname === "www.garticphone.com") {
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
  // Rewrite absolute references to garticphone.com and its subdomains so
  // subsequent requests (scripts, assets, API calls) also route through the proxy.
  return text
    .replace(/https:\/\/(www\.)?garticphone\.com/g, proxyOrigin)
    .replace(/https:\/\/([\w-]+)\.garticphone\.com/g, (m, sub) => `${proxyOrigin}/v/${sub}.garticphone.com`);
}
