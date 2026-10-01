import type { Stage } from "./api";

// One colour and wording per stage, used by every dashboard widget.
export const STAGES: Record<Stage, { label: string; color: string; hint: string }> = {
  waiting: { label: "Waiting for the CDU", color: "yellow", hint: "Published by the facility, not yet received" },
  atCdu: { label: "At the CDU", color: "blue", hint: "Received, queried or being prepared" },
  withFacility: { label: "Returned to facility", color: "orange", hint: "The prescriber must act" },
  onTheWay: { label: "Dispatched", color: "teal", hint: "On the way to the pickup point" },
  completed: { label: "Collected", color: "green", hint: "Collected by the patient" },
  problem: { label: "Returned uncollected", color: "red", hint: "Came back to the CDU uncollected" },
  cancelled: { label: "Cancelled", color: "gray", hint: "Cancelled by the facility or the CDU" },
};
