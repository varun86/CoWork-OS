import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../../../shared/types";
import { GenericApprovalDialog } from "../GenericApprovalDialog";

function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-1",
    taskId: "task-1",
    type: "external_service",
    description: "Approve tool call: open_application",
    details: {
      tool: "open_application",
      params: { appName: "Safari" },
      permissionPrompt: {
        scope: { kind: "tool", toolName: "open_application" },
        scopePreview: "tool open_application",
        reason: {
          type: "mode",
          mode: "default",
          summary: "Default mode prompts for writes, deletes, shell, and external effects.",
        },
        suggestedActions: [
          { action: "deny_once", label: "Deny once", effect: "deny" },
          { action: "allow_once", label: "Allow once", effect: "allow" },
        ],
      },
    },
    status: "pending",
    requestedAt: Date.now(),
    ...overrides,
  };
}

describe("GenericApprovalDialog", () => {
  it("explains open_application approvals with the concrete app and system action", () => {
    const html = renderToStaticMarkup(React.createElement(GenericApprovalDialog, {
      approval: makeApproval(),
      onRespond: vi.fn(),
    }));

    expect(html).toContain("Open application");
    expect(html).toContain("Allow CoWork OS to open Safari?");
    expect(html).toContain("system action");
    expect(html).toContain("open_application");
    expect(html).toContain("Application");
    expect(html).toContain("Safari");
    expect(html).toContain("CoWork OS launches Safari on this computer.");
  });
});
