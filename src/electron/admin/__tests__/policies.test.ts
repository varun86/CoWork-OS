import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  watch: vi.fn(),
}));

vi.mock("fs", () => mockFs);

vi.mock("../../utils/user-data-dir", () => ({
  getUserDataDir: () => "/mock/user/data",
}));

import { validatePolicies } from "../policies";

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("validatePolicies", () => {
  it("accepts non-conflicting pack policy lists", () => {
    expect(
      validatePolicies({
        packs: {
          allowed: ["alpha", "beta"],
          blocked: ["blocked-pack"],
          required: ["alpha"],
        },
      }),
    ).toBeNull();
  });

  it("rejects required IDs that are also blocked", () => {
    expect(
      validatePolicies({
        packs: {
          allowed: [],
          blocked: ["shared-pack"],
          required: ["shared-pack", "other-pack"],
        },
      }),
    ).toBe("A pack ID cannot be both required and blocked");
  });

  it("requires required IDs to be in allowlist when allowlist is set", () => {
    expect(
      validatePolicies({
        packs: {
          allowed: ["core-pack"],
          blocked: [],
          required: ["missing-pack"],
        },
      }),
    ).toBe("All required packs must also be in allowed list when allowlist is set");
  });

  it("accepts runtime safety policies", () => {
    expect(
      validatePolicies({
        runtime: {
          allowedPermissionModes: ["default", "dangerous_only"],
          allowedSandboxTypes: ["macos", "docker"],
          requireSandboxForShell: true,
          allowUnsandboxedShell: false,
          network: {
            defaultAction: "deny",
            allowedDomains: ["docs.example.com"],
            blockedDomains: ["*.tracking.example"],
            allowShellNetwork: false,
          },
          telemetry: {
            enabled: true,
            otlpEndpoint: "http://127.0.0.1:4318/v1/traces",
          },
        },
      }),
    ).toBeNull();
  });

  it("rejects invalid runtime sandbox types", () => {
    expect(
      validatePolicies({
        runtime: {
          allowedSandboxTypes: ["bare-metal"],
        },
      }),
    ).toBe("runtime.allowedSandboxTypes contains an invalid sandbox type");
  });

  it("rejects invalid shell network policy type", () => {
    expect(
      validatePolicies({
        runtime: {
          network: {
            allowShellNetwork: "yes",
          },
        },
      }),
    ).toBe("runtime.network.allowShellNetwork must be a boolean");
  });

  it("accepts Everyday Agent admin policy controls", () => {
    expect(
      validatePolicies({
        everydayAgent: {
          blocked: false,
          blockedBundles: ["browser", "screen_context"],
          forceReviewOnly: true,
          maxHeartbeatCadenceMinutes: 15,
          maxConcurrentBackgroundWork: 1,
        },
      }),
    ).toBeNull();
  });

  it("rejects invalid Everyday Agent bundles", () => {
    expect(
      validatePolicies({
        everydayAgent: {
          blockedBundles: ["browser", "all_the_things"],
        },
      }),
    ).toBe("everydayAgent.blockedBundles contains an invalid bundle");
  });
});

describe("loadPoliciesStrict", () => {
  it("does not fall back to permissive defaults when an existing policy file is invalid", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("{");
    const { loadPoliciesStrict: freshLoadPoliciesStrict } = await import("../policies");

    expect(freshLoadPoliciesStrict()).toBeNull();
  });

  it("keeps the last valid policy when a later read is invalid", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync
      .mockReturnValueOnce(JSON.stringify({ packs: { blocked: ["smb-complete"] } }))
      .mockReturnValueOnce("{");
    const { loadPoliciesStrict: freshLoadPoliciesStrict } = await import("../policies");

    expect(freshLoadPoliciesStrict()?.packs.blocked).toEqual(["smb-complete"]);
    expect(freshLoadPoliciesStrict()?.packs.blocked).toEqual(["smb-complete"]);
  });

  it("rejects invalid Everyday Agent bundles before normalization can drop them", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({ everydayAgent: { blockedBundles: ["browser", "all_the_things"] } }),
    );
    const { loadPoliciesStrict: freshLoadPoliciesStrict } = await import("../policies");

    expect(freshLoadPoliciesStrict()).toBeNull();
  });

  it("loadPolicies remains permissive only when no valid policy is available", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue("{");
    const { loadPolicies: freshLoadPolicies } = await import("../policies");

    expect(freshLoadPolicies().packs.blocked).toEqual([]);
  });
});
