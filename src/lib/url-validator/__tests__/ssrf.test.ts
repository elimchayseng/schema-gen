import { describe, it, expect } from "vitest";
import { isPrivateHostname } from "../fetcher";

describe("isPrivateHostname", () => {
  it("blocks localhost", () => {
    expect(isPrivateHostname("localhost")).toBe(true);
    expect(isPrivateHostname("LOCALHOST")).toBe(true);
  });

  it("blocks .local domains", () => {
    expect(isPrivateHostname("myhost.local")).toBe(true);
    expect(isPrivateHostname("internal.server.local")).toBe(true);
  });

  it("blocks 127.0.0.0/8 (loopback)", () => {
    expect(isPrivateHostname("127.0.0.1")).toBe(true);
    expect(isPrivateHostname("127.255.255.255")).toBe(true);
  });

  it("blocks 10.0.0.0/8", () => {
    expect(isPrivateHostname("10.0.0.1")).toBe(true);
    expect(isPrivateHostname("10.255.255.255")).toBe(true);
  });

  it("blocks 172.16.0.0/12", () => {
    expect(isPrivateHostname("172.16.0.1")).toBe(true);
    expect(isPrivateHostname("172.31.255.255")).toBe(true);
    // 172.15.x.x is NOT private
    expect(isPrivateHostname("172.15.0.1")).toBe(false);
    // 172.32.x.x is NOT private
    expect(isPrivateHostname("172.32.0.1")).toBe(false);
  });

  it("blocks 192.168.0.0/16", () => {
    expect(isPrivateHostname("192.168.0.1")).toBe(true);
    expect(isPrivateHostname("192.168.255.255")).toBe(true);
  });

  it("blocks 169.254.0.0/16 (link-local / metadata)", () => {
    expect(isPrivateHostname("169.254.0.1")).toBe(true);
    expect(isPrivateHostname("169.254.169.254")).toBe(true);
  });

  it("blocks 0.0.0.0", () => {
    expect(isPrivateHostname("0.0.0.0")).toBe(true);
  });

  it("blocks IPv6 loopback", () => {
    expect(isPrivateHostname("::1")).toBe(true);
    expect(isPrivateHostname("[::1]")).toBe(true);
  });

  it("allows public hostnames", () => {
    expect(isPrivateHostname("example.com")).toBe(false);
    expect(isPrivateHostname("8.8.8.8")).toBe(false);
    expect(isPrivateHostname("203.0.113.1")).toBe(false);
    expect(isPrivateHostname("google.com")).toBe(false);
  });
});
