/**
 * Conditional GET over node:https.
 *
 * Why not global fetch(): undici does not produce a 304 from Lever's API even
 * when replaying the exact ETag the same request just returned — verified by
 * A/B against curl and node:https, which both get 304 for that byte-identical
 * validator. Since "most polls cost a 304 with no body" is the assumption that
 * makes 3-minute tier-S polling affordable, this path uses node:https directly.
 */

import https from "node:https";
import http from "node:http";
import { URL } from "node:url";
import zlib from "node:zlib";

const UA = "job-hunt/0.1 (+personal job search tooling)";

const agent = new https.Agent({ keepAlive: true, maxSockets: 64, timeout: 30_000 });
// Local providers (Ollama) speak plain HTTP; everything remote is HTTPS.
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16, timeout: 30_000 });

function decompress(buf, encoding) {
  if (!buf.length) return Buffer.alloc(0);
  try {
    switch ((encoding || "").toLowerCase()) {
      case "gzip":
        return zlib.gunzipSync(buf);
      case "deflate":
        return zlib.inflateSync(buf);
      case "br":
        return zlib.brotliDecompressSync(buf);
      default:
        return buf;
    }
  } catch {
    return buf; // some servers mislabel; fall back to raw
  }
}

/**
 * @returns {Promise<{status:'ok'|'not_modified'|'error', httpStatus:number,
 *                    body?:string, etag?:string|null, lastModified?:string|null,
 *                    error?:string}>}
 */
export function conditionalGet(
  url,
  {
    etag,
    lastModified,
    timeout = 20_000,
    redirects = 3,
    method = "GET",
    body = null,
    headers: extraHeaders = null,
  } = {},
) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    let u;
    try {
      u = new URL(url);
    } catch {
      return done({ status: "error", httpStatus: 0, error: "bad_url" });
    }

    const headers = {
      accept: "application/json",
      "accept-encoding": "gzip, deflate, br",
      "user-agent": UA,
    };
    let payload = null;
    if (body != null) {
      payload = Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }
    if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) {
      if (v != null) headers[k.toLowerCase()] = String(v);
    }
    if (etag) headers["if-none-match"] = etag;
    if (lastModified) headers["if-modified-since"] = lastModified;

    const isHttp = u.protocol === "http:";
    const transport = isHttp ? http : https;
    const req = transport.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttp ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        method,
        headers,
        agent: isHttp ? httpAgent : agent,
      },
      (res) => {
        const status = res.statusCode || 0;
        const nextEtag = res.headers.etag || null;
        const nextLM = res.headers["last-modified"] || null;

        if (status === 304) {
          res.resume();
          return done({
            status: "not_modified",
            httpStatus: 304,
            etag: etag ?? null,
            lastModified: lastModified ?? null,
          });
        }

        // follow redirects (boards occasionally move between ATS hosts)
        if (
          status >= 300 &&
          status < 400 &&
          res.headers.location &&
          redirects > 0
        ) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return done(
            conditionalGet(next, {
              etag,
              lastModified,
              timeout,
              redirects: redirects - 1,
              method,
              body,
              headers: extraHeaders,
            }),
          );
        }

        const chunks = [];
        let bytes = 0;
        res.on("data", (c) => {
          bytes += c.length;
          // 40MB guard — no legitimate board response is close to this.
          if (bytes > 40 * 1024 * 1024) {
            req.destroy();
            return done({
              status: "error",
              httpStatus: status,
              error: "body_too_large",
            });
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const text = decompress(
            Buffer.concat(chunks),
            res.headers["content-encoding"],
          ).toString("utf8");
          if (status < 200 || status >= 300) {
            // Rate-limit hint: seconds, or an HTTP-date. Callers back off on it.
            const ra = res.headers["retry-after"];
            let retryAfterMs = null;
            if (ra != null) {
              const n = Number(ra);
              retryAfterMs = Number.isFinite(n)
                ? n * 1000
                : Math.max(0, new Date(ra).getTime() - Date.now()) || null;
            }
            return done({
              status: "error",
              httpStatus: status,
              retryAfterMs,
              // Carry the body. A bare status code makes an API rejection
              // indistinguishable from a network fault, which is how a 400
              // "decommissioned model" read as a hang for several minutes.
              errorBody: text.slice(0, 500),
              etag: nextEtag,
              lastModified: nextLM,
            });
          }
          done({
            status: "ok",
            httpStatus: status,
            body: text,
            etag: nextEtag,
            lastModified: nextLM,
          });
        });
        res.on("error", (err) =>
          done({
            status: "error",
            httpStatus: status,
            error: String(err?.message || err),
          }),
        );
      },
    );

    req.setTimeout(timeout, () => {
      req.destroy();
      done({ status: "error", httpStatus: 0, error: "timeout" });
    });
    if (payload) req.write(payload);
    req.on("error", (err) =>
      done({
        status: "error",
        httpStatus: 0,
        error: String(err?.message || err),
      }),
    );
    req.end();
  });
}

/** POST JSON and parse the response. Used by Workday's cxs API. */
export async function postJson(url, body, opts = {}) {
  return getJson(url, { ...opts, method: "POST", body });
}

export async function getJson(url, opts = {}) {
  const res = await conditionalGet(url, opts);
  if (res.status !== "ok") return { ...res, data: null };
  try {
    return { ...res, data: JSON.parse(res.body) };
  } catch {
    return {
      status: "error",
      httpStatus: res.httpStatus,
      error: "unparseable_json",
      data: null,
    };
  }
}
