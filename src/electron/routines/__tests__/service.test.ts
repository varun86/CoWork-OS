import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HooksConfig } from "../../hooks/types";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Database = module.default;
      const probe = new Database(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("RoutineService", () => {
  let db: import("better-sqlite3").Database;
  let RoutineServiceCtor: typeof import("../service").RoutineService;
  let EventTriggerServiceCtor: typeof import("../../triggers/EventTriggerService").EventTriggerService;
  let routineService: import("../service").RoutineService;
  let eventTriggerService: import("../../triggers/EventTriggerService").EventTriggerService;
  let hooksSettings: HooksConfig;
  let cronService: {
    add: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    const Database = (await import("better-sqlite3")).default;
    db = new Database(":memory:");

    ({ RoutineService: RoutineServiceCtor } = await import("../service"));
    ({ EventTriggerService: EventTriggerServiceCtor } = await import(
      "../../triggers/EventTriggerService"
    ));

    hooksSettings = {
      enabled: true,
      token: "global-token",
      path: "/hooks",
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    };

    cronService = {
      add: vi.fn().mockImplementation(async (job) => ({
        ok: true,
        job: { id: "cron-1", ...job, state: {} },
      })),
      update: vi.fn().mockImplementation(async (_id, patch) => ({
        ok: true,
        job: { id: "cron-1", ...patch, state: {} },
      })),
      remove: vi.fn().mockResolvedValue({ ok: true, removed: true }),
    };

    eventTriggerService = new EventTriggerServiceCtor({
      createTask: vi.fn().mockResolvedValue({ id: "task-1" }),
      getDefaultWorkspaceId: () => "ws-default",
      log: vi.fn(),
    });
    eventTriggerService.start();

    routineService = new RoutineServiceCtor({
      db,
      getCronService: () => cronService as Any,
      getEventTriggerService: () => eventTriggerService,
      loadHooksSettings: () => hooksSettings,
      saveHooksSettings: (settings) => {
        hooksSettings = settings;
      },
    });
  });

  it("creates managed schedule, api, and connector-event triggers", async () => {
    const routine = await routineService.create({
      name: "PR Triage",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Review the incoming signal and draft the next action.",
      connectors: ["github", "linear"],
      triggers: [
        {
          id: "schedule-1",
          type: "schedule",
          enabled: true,
          schedule: { kind: "cron", expr: "0 2 * * *" },
        },
        {
          id: "api-1",
          type: "api",
          enabled: true,
        },
        {
          id: "connector-1",
          type: "connector_event",
          enabled: true,
          connectorId: "github",
          changeType: "resource_updated",
        },
      ],
    });

    expect(cronService.add).toHaveBeenCalledTimes(1);
    expect(hooksSettings.mappings).toHaveLength(1);
    expect(hooksSettings.mappings[0]?.match?.path).toContain(`routines/${routine.id}/api-1`);
    expect(hooksSettings.mappings[0]?.token).toBeTruthy();
    expect(eventTriggerService.listTriggers()).toHaveLength(1);
    expect(
      routine.triggers.find((trigger) => trigger.type === "schedule" && trigger.managedCronJobId),
    ).toBeTruthy();
    expect(
      routine.triggers.find((trigger) => trigger.type === "api" && trigger.token),
    ).toBeTruthy();
    expect(
      routine.triggers.find(
        (trigger) => trigger.type === "connector_event" && trigger.managedEventTriggerId,
      ),
    ).toBeTruthy();
  });

  it("removes managed resources when a routine is deleted", async () => {
    const routine = await routineService.create({
      name: "Deploy Alerts",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Triage deployment alerts.",
      connectors: [],
      triggers: [
        {
          id: "schedule-1",
          type: "schedule",
          enabled: true,
          schedule: { kind: "cron", expr: "*/15 * * * *" },
        },
        {
          id: "api-1",
          type: "api",
          enabled: true,
        },
        {
          id: "connector-1",
          type: "connector_event",
          enabled: true,
          connectorId: "github",
        },
      ],
    });

    const removed = await routineService.remove(routine.id);

    expect(removed).toBe(true);
    expect(cronService.remove).toHaveBeenCalledTimes(1);
    expect(hooksSettings.mappings).toHaveLength(0);
    expect(eventTriggerService.listTriggers()).toHaveLength(0);
  });

  it("refreshes a manual run without creating duplicate run rows", async () => {
    let now = 1_779_000_000_000;
    routineService = new RoutineServiceCtor({
      db,
      getCronService: () => cronService as Any,
      getEventTriggerService: () => eventTriggerService,
      loadHooksSettings: () => hooksSettings,
      saveHooksSettings: (settings) => {
        hooksSettings = settings;
      },
      createTask: vi.fn().mockResolvedValue({ id: "task-1" }),
      getTaskSnapshot: vi.fn().mockReturnValue({
        status: "failed",
        terminalStatus: "failed",
        error: "Task missing verification evidence",
        completedAt: now + 100,
      }),
      now: () => now++,
    });

    const routine = await routineService.create({
      name: "Build Health",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Check build health.",
      connectors: [],
      triggers: [{ id: "manual-1", type: "manual", enabled: true }],
    });

    await routineService.runNow(routine.id);
    await routineService.listRuns(routine.id, 10);
    await routineService.listRuns(routine.id, 10);

    const rowCount = db
      .prepare("SELECT COUNT(*) AS count FROM routine_runs WHERE routine_id = ?")
      .get(routine.id) as { count: number };
    const runs = await routineService.listRuns(routine.id, 10);

    expect(rowCount.count).toBe(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.backingTaskId).toBe("task-1");
  });

  it("refreshes a task-backed routine run when the backing task finishes", async () => {
    let taskStatus = "executing";
    const getTaskSnapshot = vi.fn(() => ({
      status: taskStatus,
      terminalStatus: taskStatus === "completed" ? "ok" : undefined,
      resultSummary: taskStatus === "completed" ? "Build checks passed." : undefined,
      completedAt: taskStatus === "completed" ? 1_779_000_000_100 : undefined,
    }));
    routineService = new RoutineServiceCtor({
      db,
      getCronService: () => cronService as Any,
      getEventTriggerService: () => eventTriggerService,
      loadHooksSettings: () => hooksSettings,
      saveHooksSettings: (settings) => {
        hooksSettings = settings;
      },
      createTask: vi.fn().mockResolvedValue({ id: "task-1" }),
      getTaskSnapshot,
      now: () => 1_779_000_000_000,
    });

    const routine = await routineService.create({
      name: "Build Health",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Check build health.",
      connectors: [],
      triggers: [{ id: "manual-1", type: "manual", enabled: true }],
    });
    await routineService.runNow(routine.id);

    taskStatus = "completed";
    await routineService.refreshRunsForTask("task-1");

    const runs = await routineService.listRuns(routine.id, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");
    expect(runs[0]?.finishedAt).toBe(1_779_000_000_100);
    expect(runs[0]?.artifactsSummary).toBe("Build checks passed.");
  });

  it("collapses historical duplicate run rows that point at the same backing task", async () => {
    const routine = await routineService.create({
      name: "Build Health",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Check build health.",
      connectors: [],
      triggers: [{ id: "manual-1", type: "manual", enabled: true }],
    });

    const base = 1_779_000_000_000;
    db.prepare(
      `INSERT INTO routine_runs
       (id, routine_id, trigger_id, trigger_type, status, started_at, finished_at,
        source_event_summary, backing_task_id, backing_managed_session_id, output_status,
        error_summary, artifacts_summary, run_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-1",
      routine.id,
      "manual-1",
      "manual",
      "running",
      base,
      null,
      "Manual run",
      "task-1",
      null,
      "none",
      null,
      null,
      null,
      base,
      base,
    );
    db.prepare(
      `INSERT INTO routine_runs
       (id, routine_id, trigger_id, trigger_type, status, started_at, finished_at,
        source_event_summary, backing_task_id, backing_managed_session_id, output_status,
        error_summary, artifacts_summary, run_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-2",
      routine.id,
      "manual-1",
      "manual",
      "failed",
      base,
      base + 1,
      "Manual run",
      "task-1",
      null,
      "failed",
      "Task missing verification evidence",
      null,
      null,
      base + 1,
      base + 1,
    );

    const runs = await routineService.listRuns(routine.id, 10);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe("run-2");
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.errorSummary).toBe("Task missing verification evidence");
  });
});
