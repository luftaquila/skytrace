import crypto from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);

function encodings(header) {
  const values = new Map();
  for (const part of String(header || "").split(",")) {
    const [namePart, ...parameters] = part.trim().split(";");
    const name = namePart.trim().toLowerCase();
    if (!name) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const match = parameter.trim().match(/^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i);
      if (match) quality = Number(match[1]);
    }
    values.set(name, quality);
  }
  return values;
}

export function negotiateEncoding(header, gzipAvailable = true) {
  const values = encodings(header);
  const wildcard = values.get("*");
  const gzipQuality = values.has("gzip") ? values.get("gzip") : wildcard ?? 0;
  const identityQuality = values.has("identity")
    ? values.get("identity")
    : wildcard === 0 ? 0 : 1;
  if (gzipAvailable && gzipQuality > 0 && gzipQuality >= identityQuality) return "gzip";
  if (identityQuality > 0) return "identity";
  if (gzipAvailable && gzipQuality > 0) return "gzip";
  return null;
}

export function strongEtag(bytes) {
  return `"sha256-${crypto.createHash("sha256").update(bytes).digest("base64url")}"`;
}

export function etagMatches(header, etag) {
  return String(header || "").split(",").some((value) => {
    const candidate = value.trim();
    return candidate === "*" || candidate === etag;
  });
}

export function sendEncoded(req, res, representation, { contentType = "application/json" } = {}) {
  const encoding = negotiateEncoding(req.get("accept-encoding"), Boolean(representation.gzip));
  if (!encoding) {
    res.status(406).json({ ok: false, error: "no acceptable content encoding" });
    return;
  }
  const bytes = encoding === "gzip" ? representation.gzip : representation.identity;
  const etag = encoding === "gzip" ? representation.gzipEtag : representation.identityEtag;
  res.type(contentType);
  res.set("vary", "Accept-Encoding");
  res.set("etag", etag);
  if (encoding === "gzip") res.set("content-encoding", "gzip");
  if (["GET", "HEAD"].includes(req.method) && etagMatches(req.get("if-none-match"), etag)) {
    res.status(304).end();
    return;
  }
  res.set("content-length", String(bytes.byteLength));
  if (req.method === "HEAD") res.end();
  else res.end(bytes);
}

function encodeJsonIdentity(value, {
  maxIdentityBytes = Number.POSITIVE_INFINITY,
} = {}) {
  const identity = Buffer.from(JSON.stringify(value));
  if (identity.byteLength > maxIdentityBytes) {
    const error = new RangeError(`JSON representation exceeds ${maxIdentityBytes} bytes`);
    error.code = "JSON_REPRESENTATION_TOO_LARGE";
    throw error;
  }
  return {
    identity,
    gzip: null,
    identityEtag: strongEtag(identity),
    gzipEtag: null,
  };
}

async function addGzip(representation) {
  const compressed = await gzipAsync(representation.identity, { level: 6 });
  representation.gzip = compressed;
  representation.gzipEtag = strongEtag(compressed);
  return representation;
}

export async function encodeJson(value, {
  gzipThreshold = 1024,
  maxIdentityBytes = Number.POSITIVE_INFINITY,
} = {}) {
  const representation = encodeJsonIdentity(value, { maxIdentityBytes });
  if (representation.identity.byteLength >= gzipThreshold) await addGzip(representation);
  return representation;
}

export async function encodeJsonForRequest(acceptEncoding, value, {
  gzipThreshold = 1024,
  maxIdentityBytes = Number.POSITIVE_INFINITY,
} = {}) {
  const representation = encodeJsonIdentity(value, { maxIdentityBytes });
  const canGzip = representation.identity.byteLength >= gzipThreshold;
  const encoding = negotiateEncoding(acceptEncoding, canGzip);
  if (encoding === "gzip") await addGzip(representation);
  return { encoding, representation };
}

export async function sendJson(req, res, value, options = {}) {
  const { encoding, representation } = await encodeJsonForRequest(
    req.get("accept-encoding"),
    value,
    options,
  );
  if (!encoding) {
    res.status(406).json({ ok: false, error: "no acceptable content encoding" });
    return;
  }
  sendEncoded(req, res, representation);
}
