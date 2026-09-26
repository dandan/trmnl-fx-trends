// Cloudflare Worker: currency pairs -> plot-ready sparkline JSON for TRMNL.
//
//   GET /rates?pairs=GBP/AUD,EUR/USD&range=1Y&w=200&h=30
//
// Access control is the TRMNL IP allowlist alone (see allowlist.js). There is no
// bearer token: this is a public plugin, so any token shipped in the recipe would
// be public too, and a shared secret that everyone holds secures nothing.
//
// The device does no arithmetic: `points` is an SVG coordinate string already
// scaled to the w x h box, so the Liquid is <polyline points="{{ row.points }}"/>.
// See BUILD_PLAN.md §2.1 for why this lives in a Worker at all.

// NOTE: this module must export nothing but the default handler. workerd treats
// every named export of the entrypoint as a service entrypoint and requires it
// to be a function or ExportedHandler, so exporting a constant here stops the
// runtime from starting. Shared helpers live in source.js.

import {
  SUPPORTED, RANGES, HttpError, rangeToDates, symbolUnion, fetchRates, parsePairs,
} from "./source.js";
import { buildResponse } from "./shape.js";
import { ipAllowed } from "./allowlist.js";

const W_MIN = 40, W_MAX = 800;
const H_MIN = 10, H_MAX = 200;

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function clampInt(value, def, min, max) {
  const n = parseInt(value ?? "", 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
}

async function handleRates(url, fetchImpl) {
  const pairs = parsePairs(url.searchParams.get("pairs"));
  const range = (url.searchParams.get("range") || "1Y").toUpperCase();
  if (!RANGES[range]) {
    throw new HttpError(400, `Unknown range '${range}'. Valid: ${Object.keys(RANGES).join(", ")}.`);
  }
  const w = clampInt(url.searchParams.get("w"), 200, W_MIN, W_MAX);
  const h = clampInt(url.searchParams.get("h"), 30, H_MIN, H_MAX);

  const { start, end } = rangeToDates(range);
  const rates = await fetchRates(symbolUnion(pairs), start, end, fetchImpl);

  return buildResponse(rates, pairs, { range, w, h });
}

export default {
  async fetch(request, env, ctx, fetchImpl = fetch) {
    const url = new URL(request.url);

    // Public, data-free health endpoint (no auth).
    if (url.pathname === "/" || url.pathname === "") {
      return json({
        service: "exchange-rates-trmnl-worker",
        // Stamped by deploy.sh from `git describe`; absent under `wrangler dev`.
        version: env?.VERSION ?? "dev",
        env: env?.DEPLOY_ENV ?? "prod",
        usage: "/rates?pairs=GBP/AUD,EUR/USD&range=1Y&w=200&h=30",
        ranges: Object.keys(RANGES),
        currencies: SUPPORTED.size,
      });
    }

    if (url.pathname !== "/rates") {
      return json({ error: "Not found" }, 404);
    }

    if (!(await ipAllowed(request.headers.get("CF-Connecting-IP")))) {
      return json({ error: "Forbidden" }, 403);
    }

    try {
      const body = await handleRates(url, fetchImpl);
      // Only a non-production environment names itself (see wrangler.toml), so
      // the field is absent from what installers of the recipe receive.
      if (env?.DEPLOY_ENV) body.env = env.DEPLOY_ENV;
      return json(body, 200, { "Cache-Control": "public, max-age=3600" });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      // An upstream failure returns a clean error rather than a partial screen;
      // the plugin keeps showing its last successful render.
      return json({ error: err.message || "Unexpected error" }, status);
    }
  },
};
