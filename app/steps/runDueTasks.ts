import { claimTask, deleteTask, fetchDueTaskIds, getTask, releaseTaskClaim, rescheduleTaskAfterError } from "@/app/lib/tasks";
import { sendOutbound } from "@/app/steps/sendOutbound";

export async function runDueTasks() {
  "use step";

  const now = Date.now();
  const ids = await fetchDueTaskIds(now, 25);
  let executed = 0;
  let skipped = 0;
  let failed = 0;

  for (const id of ids) {
    const claim = await claimTask(id, 120);
    if (!claim.claimed) {
      skipped += 1;
      continue;
    }

    try {
      const task = await getTask(id);
      if (!task) {
        await deleteTask(id);
        skipped += 1;
        continue;
      }

      if (task.type === "send") {
        await sendOutbound({
          channel: task.channel,
          sessionId: task.sessionId,
          text: task.text,
          idempotencyKey: task.idempotencyKey ?? `task:${task.id}`,
        });
      }

      await deleteTask(id);
      executed += 1;
    } catch (error) {
      failed += 1;
      const task = await getTask(id);
      if (task) await rescheduleTaskAfterError(task, error);
    } finally {
      await releaseTaskClaim(id, claim.token);
    }
  }

  return { executed, skipped, failed, seen: ids.length };
}
