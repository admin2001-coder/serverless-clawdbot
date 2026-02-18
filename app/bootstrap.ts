import { start } from "workflow/api";
import { daemonWorkflow } from "@/app/workflows/daemon";
import { autopilotWorkflow } from "@/app/workflows/autopilot";

let started = false;

export async function bootstrapDev() {
  if (started) return;
  started = true;

  if (process.env.NODE_ENV !== "production") {
    await start(daemonWorkflow, []);
    await start(autopilotWorkflow, []);
    console.log("Dev workflows started");
  }
}
