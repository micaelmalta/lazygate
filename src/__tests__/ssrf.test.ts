// SSRF guards: private/link-local after DNS, https preference, token endpoint origin.

import { describe, it, expect } from "@jest/globals";
import {
  assertSafeUrl,
  assertTokenEndpointMatchesIssuer,
  isLoopbackAddress,
  isPrivateOrLinkLocal,
  UnsafeUrlError,
} from "../ssrf.js";

describe("isPrivateOrLinkLocal / isLoopbackAddress", () => {
  it("classifies common private and link-local ranges", () => {
    expect(isPrivateOrLinkLocal("10.0.0.1")).toBe(true);
    expect(isPrivateOrLinkLocal("172.16.5.1")).toBe(true);
    expect(isPrivateOrLinkLocal("192.168.1.1")).toBe(true);
    expect(isPrivateOrLinkLocal("169.254.169.254")).toBe(true);
    expect(isPrivateOrLinkLocal("8.8.8.8")).toBe(false);
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrLinkLocal("fe80::1")).toBe(true);
    expect(isPrivateOrLinkLocal("fd12::1")).toBe(true);
  });
});

describe("assertSafeUrl", () => {
  it("allows https public hosts and http loopback", async () => {
    await expect(assertSafeUrl("http://127.0.0.1:9/x")).resolves.toBeInstanceOf(URL);
    await expect(assertSafeUrl("http://localhost/x")).resolves.toBeInstanceOf(URL);
  });

  it("rejects non-https to non-loopback and literal private IPs", async () => {
    await expect(assertSafeUrl("http://example.com/x")).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertSafeUrl("http://169.254.169.254/latest")).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertSafeUrl("https://10.0.0.1/mcp")).rejects.toMatchObject({
      name: "UnsafeUrlError",
      message: expect.stringMatching(/private|link-local/i),
    });
    await expect(assertSafeUrl("https://192.168.0.1/")).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});

describe("assertTokenEndpointMatchesIssuer", () => {
  it("allows token_endpoint on the issuer origin", () => {
    expect(() =>
      assertTokenEndpointMatchesIssuer("https://as.example.com/token", "https://as.example.com")
    ).not.toThrow();
  });

  it("allows token_endpoint on the authorization_endpoint origin (Slack/Datadog style)", () => {
    expect(() =>
      assertTokenEndpointMatchesIssuer(
        "https://slack.com/api/oauth.v2.user.access",
        "https://mcp.slack.com",
        "https://slack.com/oauth/v2_user/authorize"
      )
    ).not.toThrow();
    expect(() =>
      assertTokenEndpointMatchesIssuer(
        "https://app.datadoghq.com/oauth/token",
        "https://mcp.datadoghq.com",
        "https://app.datadoghq.com/oauth/authorize"
      )
    ).not.toThrow();
  });

  it("rejects a token_endpoint on an unrelated origin", () => {
    expect(() =>
      assertTokenEndpointMatchesIssuer("https://evil.example.com/token", "https://as.example.com")
    ).toThrow(/must match/i);
    expect(() =>
      assertTokenEndpointMatchesIssuer(
        "https://evil.example.com/token",
        "https://mcp.slack.com",
        "https://slack.com/oauth/v2_user/authorize"
      )
    ).toThrow(/must match/i);
  });
});
