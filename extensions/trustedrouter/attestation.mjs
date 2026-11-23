// Checks TrustedRouter's attested gateway the way its published client
// verification does (https://trustedrouter.com/trust): fetch /attestation with
// a fresh nonce, verify Google's Confidential Space signature, compare the
// measured image with the published release, and confirm the token is bound
// to the TLS session and certificate it arrived over.

import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import https from "node:https";

export const GATEWAY_HOST = "api.trustedrouter.com";
export const ISSUER = "https://confidentialcomputing.googleapis.com";
export const AUDIENCE = "quill-cloud";
const PUBLISHED_DIGEST_URL = "https://trustedrouter.com/trust/image-digest-gcp.txt";
const EXPORTER_LABEL = "EXPORTER-Channel-Binding";
const EXPORTER_LENGTH = 32;
const CLOCK_SKEW_SECONDS = 60;
const DEBUG_ENABLED = new Set(["enabled", "enable", "true", "1", "debug"]);

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const decodeJson = (segment) => JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

function* claimEntries(value) {
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    yield [key, child];
    yield* claimEntries(child);
  }
}

function verifySignature(header, signingInput, signature, jwks) {
  if (header.alg !== "RS256") {
    throw new Error(`attestation uses ${header.alg}, not RS256`);
  }
  const jwk = jwks?.keys?.find((key) => key.kid === header.kid);
  if (!jwk) {
    throw new Error(`attestation key ${header.kid} is not among Google's published keys`);
  }
  const key = createPublicKey({ key: jwk, format: "jwk" });
  if (!verify("RSA-SHA256", Buffer.from(signingInput), key, signature)) {
    throw new Error("attestation signature does not verify against Google's published keys");
  }
}

function verifyIdentity(claims, now) {
  if (claims.iss !== ISSUER) {
    throw new Error(`attestation issuer is ${claims.iss}, not ${ISSUER}`);
  }
  if (![claims.aud].flat().includes(AUDIENCE)) {
    throw new Error(`attestation audience is ${claims.aud}, not ${AUDIENCE}`);
  }
  const nowSeconds = now / 1000;
  if (!(claims.exp > nowSeconds - CLOCK_SKEW_SECONDS)) {
    throw new Error("attestation has expired");
  }
  if (claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new Error("attestation is not valid yet");
  }
  for (const [key, value] of claimEntries(claims)) {
    if (key.toLowerCase() === "dbgstat" && DEBUG_ENABLED.has(String(value).toLowerCase())) {
      throw new Error("the gateway enclave runs with debugging enabled");
    }
  }
}

// Each value must appear among the token's nonces: the caller's nonce proves
// freshness, the TLS exporter proves it was issued for this session, and the
// certificate fingerprint ties the gateway's TLS key to the measured workload.
function verifyBindings(claims, bindings) {
  const nonces = [claims.eat_nonce].flat().map((value) => String(value).toLowerCase());
  const checks = [
    [bindings.nonce, "does not echo this check's nonce, so it could be a replay"],
    [bindings.exporter, "is not bound to the TLS session it arrived over"],
    [bindings.certFingerprint, "does not bind the certificate the gateway presented"],
  ];
  for (const [value, problem] of checks) {
    if (!nonces.includes(value.toLowerCase())) {
      throw new Error(`attestation ${problem}`);
    }
  }
}

/**
 * Verifies a Confidential Space attestation token against Google's keys, the
 * published image digest and the session it was fetched over.
 *
 * Throws an Error naming the first check that fails; returns a summary of the
 * attested environment otherwise.
 */
export function verifyGatewayToken({ token, jwks, publishedDigest, bindings, now = Date.now() }) {
  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    throw new Error("attestation is not a signed token");
  }
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  const claims = decodeJson(encodedClaims);
  verifySignature(
    decodeJson(encodedHeader),
    `${encodedHeader}.${encodedClaims}`,
    Buffer.from(encodedSignature, "base64url"),
    jwks,
  );
  verifyIdentity(claims, now);
  const imageDigest = claims.submods?.container?.image_digest;
  if (imageDigest !== publishedDigest) {
    throw new Error(
      `gateway runs image ${imageDigest}, but TrustedRouter publishes ${publishedDigest}`,
    );
  }
  verifyBindings(claims, bindings);
  return {
    hardware: claims.hwmodel,
    software: claims.swname,
    secureBoot: claims.secboot === true,
    debug: claims.dbgstat,
    tcbStatus: claims.tdx?.gcp_attester_tcb_status,
    imageDigest,
    certFingerprint: bindings.certFingerprint.toLowerCase(),
  };
}

// agent: false opens a direct connection even where NODE_USE_ENV_PROXY routes
// the default agent through a proxy, as in the sbx sandbox. A proxy that
// re-encrypts the connection would otherwise break the session binding.
function directGet(url, signal, inspectSocket) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { agent: false, signal }, (response) => {
      let socketInfo;
      try {
        socketInfo = inspectSocket?.(response.socket);
      } catch (err) {
        response.destroy();
        reject(err);
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`${url} returned HTTP ${response.statusCode}`));
          return;
        }
        resolve({ body: Buffer.concat(chunks).toString("utf8"), socketInfo });
      });
    });
    request.on("error", reject);
  });
}

/** Fetches the live attestation and everything needed to verify it. */
export async function checkGateway(signal) {
  const nonce = randomBytes(32).toString("hex");
  const attestation = await directGet(
    `https://${GATEWAY_HOST}/attestation?nonce=${nonce}`,
    signal,
    (socket) => ({
      exporter: socket.exportKeyingMaterial(EXPORTER_LENGTH, EXPORTER_LABEL).toString("hex"),
      certFingerprint: sha256Hex(socket.getPeerCertificate().raw),
    }),
  );
  const config = JSON.parse(
    (await directGet(`${ISSUER}/.well-known/openid-configuration`, signal)).body,
  );
  if (typeof config.jwks_uri !== "string" || !config.jwks_uri.startsWith("https://")) {
    throw new Error("Google's Confidential Space metadata has no usable key URL");
  }
  const jwks = JSON.parse((await directGet(config.jwks_uri, signal)).body);
  const publishedDigest = (await directGet(PUBLISHED_DIGEST_URL, signal)).body.trim();
  return verifyGatewayToken({
    token: attestation.body,
    jwks,
    publishedDigest,
    bindings: { nonce, ...attestation.socketInfo },
  });
}

/**
 * The proxy Pi's own HTTPS requests use, chosen as undici's EnvHttpProxyAgent
 * (Pi's HTTP client) chooses it: https_proxy, then HTTPS_PROXY, falling back to
 * the plain-HTTP proxy when neither is set. Pi's httpProxy setting arrives
 * through the same variables. Node's own env-proxy support has no HTTP_PROXY
 * fallback and needs NODE_USE_ENV_PROXY, so it cannot be relied on to match.
 *
 * Returns the proxyEnv for an https.Agent, or undefined for a direct path.
 */
export function piProxyEnv(env = process.env) {
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY;
  const proxy = (env.https_proxy ?? env.HTTPS_PROXY) || httpProxy;
  if (!proxy) {
    return undefined;
  }
  return { HTTPS_PROXY: proxy, NO_PROXY: env.no_proxy ?? env.NO_PROXY ?? "" };
}

/**
 * Reports the certificate on the path Pi's own requests take, so a proxy
 * that decrypts traffic shows up with its own CA instead of the gateway's.
 */
export function inspectPiPath(signal, env = process.env) {
  const proxyEnv = piProxyEnv(env);
  const agent = proxyEnv ? new https.Agent({ proxyEnv }) : false;
  return new Promise((resolve, reject) => {
    const url = `https://${GATEWAY_HOST}/attestation`;
    const request = https.get(url, { agent, signal }, (response) => {
      const certificate = response.socket.getPeerCertificate();
      response.on("error", () => {});
      response.destroy();
      resolve({
        certFingerprint: sha256Hex(certificate.raw),
        issuer: [certificate.issuer?.O, certificate.issuer?.CN].filter(Boolean).join(", "),
      });
    });
    request.on("error", reject);
  });
}
