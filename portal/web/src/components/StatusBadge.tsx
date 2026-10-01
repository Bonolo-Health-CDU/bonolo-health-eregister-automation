import { Badge } from "@mantine/core";
import type { StatusInfo } from "../api";
import { STAGES } from "../stages";

export const StatusBadge = ({ status, size = "md" }: { status: StatusInfo; size?: "sm" | "md" | "lg" }) => (
  <Badge color={STAGES[status.stage].color} variant="light" size={size} title={STAGES[status.stage].hint}>
    {status.label}
  </Badge>
);
