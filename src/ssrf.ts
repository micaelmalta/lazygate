// src/ssrf.ts
// Block fetches to private / link-local addresses after DNS resolution.
// Prefer HTTPS; allow plain HTTP only to loopback (local OAuth / MCP).

import { lookup } from "dns/promises";
import { isIP } from "net";
import http from "http";
import https from "https";

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

export interface SafeUrlOptions {
  /**
   * Allow https targets that resolve to private (RFC 1918 / ULA / CGNAT) or link-local
   * addresses. Cloud metadata (169.254.0.0/16, fe80::/10) stays blocked unless this is set,
   * and 169.254.169.254 / fd00:ec2::254 stay blocked always.
   */
  allowPrivate?: boolean;
}

export interface ResolvedTarget {
  url: URL;
  /** The address the connection must use (DNS answer already validated). */
  address: string;
  family: 4 | 6;
}

const ALWAYS_BLOCKED = new Set(["169.254.169.254", "fd00:ec2::254"]);

/**
 * Parse, resolve and validate a URL for outbound fetch.
 * - Prefer https; http only for loopback hostnames.
 * - After DNS, block private/link-local unless the hostname was already loopback
 *   (or `allowPrivate` is set for that caller).
 * Returns the validated address so the caller can pin the connection to it.
 */
export async function resolveSafeUrl(urlString: string, opts: SafeUrlOptions = {}): Promise<ResolvedTarget> {
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
  const family = isIP(address) === 6 ? 6 : 4;

  if (loopbackHost) {
    if (!isLoopbackAddress(address)) {
      throw new UnsafeUrlError(`Loopback host ${host} resolved to non-loopback ${address}`);
    }
    return { url, address, family };
  }

  const bare = normalizeIp(ipv4Mapped(address) ?? address);
  if (ALWAYS_BLOCKED.has(bare)) {
    throw new UnsafeUrlError(`Refusing URL resolving to private/link-local address (${address})`);
  }
  if (isLoopbackAddress(address)) {
    throw new UnsafeUrlError(`Refusing URL resolving to private/link-local address (${address})`);
  }
  if (isPrivateOrLinkLocal(address) && !opts.allowPrivate) {
    throw new UnsafeUrlError(`Refusing URL resolving to private/link-local address (${address})`);
  }
  return { url, address, family };
}

export async function assertSafeUrl(urlString: string, opts: SafeUrlOptions = {}): Promise<URL> {
  return (await resolveSafeUrl(urlString, opts)).url;
}

/**
 * Require token_endpoint to share origin with the authorization server / issuer,
 * or with the authorization_endpoint when the AS hosts authorize+token on a
 * different site than the issuer (Slack: issuer mcp.slack.com, token slack.com).
 */
export function assertTokenEndpointMatchesIssuer(
  tokenEndpoint: string,
  issuerOrAsUrl: string,
  authorizationEndpoint?: string
): void {
  let token: URL;
  let issuer: URL;
  try {
    token = new URL(tokenEndpoint);
    issuer = new URL(issuerOrAsUrl);
  } catch {
    throw new UnsafeUrlError("Invalid token_endpoint or issuer URL");
  }
  if (token.origin === issuer.origin) return;
  if (authorizationEndpoint) {
    try {
      const auth = new URL(authorizationEndpoint);
      if (token.origin === auth.origin) return;
    } catch {
      throw new UnsafeUrlError("Invalid authorization_endpoint URL");
    }
  }
  throw new UnsafeUrlError(
    `token_endpoint origin (${token.origin}) must match authorization server (${issuer.origin})` +
      (authorizationEndpoint ? ` or authorization_endpoint` : "")
  );
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

const PINNED_MAX_BYTES = 4 * 1024 * 1024;

/**
 * fetch-like request that connects to the address validated by {@link resolveSafeUrl} instead of
 * resolving the hostname a second time (closes the DNS-rebinding window). The Host header and
 * TLS SNI/certificate checks still use the original hostname. Redirects are never followed.
 */
export async function pinnedFetch(
  urlString: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {},
  opts: SafeUrlOptions = {}
): Promise<Response> {
  const target = await resolveSafeUrl(urlString, opts);
  const { url, address, family } = target;
  const mod = url.protocol === "https:" ? https : http;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  return new Promise<Response>((resolve, reject) => {
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers: init.headers,
        signal: init.signal,
        // Pin: every connection attempt uses the validated address.
        lookup: ((_host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
          if (options?.all) cb(null, [{ address, family }]);
          else cb(null, address, family);
        }) as never,
        ...(url.protocol === "https:" && !isIP(hostname) ? { servername: hostname } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > PINNED_MAX_BYTES) {
            req.destroy(new Error("Response body too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("error", reject);
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
            else if (v !== undefined) headers.set(k, v);
          }
          const noBody = status === 204 || status === 205 || status === 304 || (status >= 100 && status < 200);
          resolve(new Response(noBody ? null : Buffer.concat(chunks), { status: status < 200 ? 200 : status, headers }));
        });
      }
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
