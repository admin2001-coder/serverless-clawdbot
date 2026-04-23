import { sleep } from "workflow";
import { runDueTasks } from "@/app/steps/runDueTasks";

export async function daemonWorkflow() {
  "use workflow";

  // Run for ~55 seconds then exit; the 1-minute cron watchdog restarts it if needed.
  // This avoids "forever" runs piling up if you redeploy frequently.
  for (let i = 0; i < 120; i++) {
    await runDueTasks();
    await sleep("1s");
  }

  return { ok: true };
}
