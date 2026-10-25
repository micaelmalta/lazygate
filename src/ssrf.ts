// src/ssrf.ts
// Block fetches to private / link-local addresses after DNS resolution.
// Prefer HTTPS; allow plain HTTP only to loopback (local OAuth / MCP).

import { lookup } from "dns/promises";
import { isIP } from "net";

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

function ipv4Mapped(ip: string): string | undefined {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(normalizeIp(ip));
  return m?.[1];
}

/** True for 127.0.0.0/8 and ::1 (including IPv4-mapped). */
export function isLoopbackAddress(ip: string): boolean {
  const mapped = ipv4Mapped(ip);
  if (mapped) return isLoopbackAddress(mapped);
  const v = normalizeIp(ip);
  if (v.includes(":")) {
    return v === "::1" || v === "0:0:0:0:0:0:0:1";
  }
  return Number(v.split(".")[0]) === 127;
}

/** Private, link-local, or unique-local (not loopback). */
export function isPrivateOrLinkLocal(ip: string): boolean {
  const mapped = ipv4Mapped(ip);
  if (mapped) return isPrivateOrLinkLocal(mapped);
  const v = normalizeIp(ip);
  if (v.includes(":")) {
    // fe80::/10 link-local, fc00::/7 unique-local
    if (/^fe[89ab]/.test(v)) return true;
    if (v.startsWith("fc") || v.startsWith("fd")) return true;
    return false;
  }
  const [a, b] = v.split(".").map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function normalizeIp(ip: string): string {
  return ip.toLowerCase().replace(/^\[|\]$/g, "");
}

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/**
 * Parse and validate a URL for outbound fetch.
 * - Prefer https; http only for loopback hostnames.
 * - After DNS, block private/link-local unless the hostname was already loopback.
 */
export async function assertSafeUrl(urlString: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new UnsafeUrlError(`Invalid URL: ${urlString}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(`Refusing non-HTTP(S) URL (${url.protocol})`);
  }

  const loopbackHost = isLoopbackHostname(url.hostname);
  if (url.protocol === "http:" && !loopbackHost) {
    throw new UnsafeUrlError(`Refusing non-HTTPS URL to ${url.hostname} (use https)`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  let address: string;
  if (isIP(host)) {
    address = host;
  } else {
    try {
      const r = await lookup(host, { verbatim: true });
      address = r.address;
    } catch (err) {
      throw new UnsafeUrlError(`DNS lookup failed for ${host}: ${(err as Error).message}`);
    }
  }

  if (loopbackHost) {
    if (!isLoopbackAddress(address)) {
      throw new UnsafeUrlError(`Loopback host ${host} resolved to non-loopback ${address}`);
    }
    return url;
  }

  if (isLoopbackAddress(address) || isPrivateOrLinkLocal(address)) {
    throw new UnsafeUrlError(`Refusing URL resolving to private/link-local address (${address})`);
  }
  return url;
}

/** Require token_endpoint to share origin with the authorization server / issuer. */
export function assertTokenEndpointMatchesIssuer(tokenEndpoint: string, issuerOrAsUrl: string): void {
  let token: URL;
  let issuer: URL;
  try {
    token = new URL(tokenEndpoint);
    issuer = new URL(issuerOrAsUrl);
  } catch {
    throw new UnsafeUrlError("Invalid token_endpoint or issuer URL");
  }
  if (token.origin !== issuer.origin) {
    throw new UnsafeUrlError(
      `token_endpoint origin (${token.origin}) must match authorization server (${issuer.origin})`
    );
  }
}

/**
 * fetch with redirect: "manual" and SSRF checks on the request URL.
 * Callers that need redirects must re-validate Location and call again.
 */
export async function safeFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const href = typeof input === "string" ? input : input.href;
  await assertSafeUrl(href);
  return fetch(href, { ...init, redirect: "manual" });
}
