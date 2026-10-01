import { Card, Group, Progress, Stack, Text, Tooltip } from "@mantine/core";
import type { Dashboard } from "../api";
import { STAGES } from "../stages";

/** Every Status Map status in order, with its share of the period's prescriptions. */
export function StatusPipeline({ dashboard }: { dashboard: Dashboard }) {
  return (
    <Card withBorder padding="lg" h="100%">
      <Text fw={600}>Status of prescriptions</Text>
      <Text size="sm" c="dimmed" mb="md">
        Current status, as published to eRegister
      </Text>
      <Stack gap="sm">
        {dashboard.statuses.map((status) => {
          const share = dashboard.total ? (status.count / dashboard.total) * 100 : 0;
          return (
            <div key={status.code}>
              <Group justify="space-between" mb={4}>
                <Tooltip label={STAGES[status.stage].hint} position="top-start">
                  <Text size="sm">{status.label}</Text>
                </Tooltip>
                <Text size="sm" fw={600} c={status.count ? undefined : "dimmed"}>
                  {status.count.toLocaleString()}
                  <Text span size="xs" c="dimmed" fw={400}>
                    {" "}
                    · {Math.round(share)}%
                  </Text>
                </Text>
              </Group>
              <Progress
                value={share}
                color={STAGES[status.stage].color}
                size="sm"
                aria-label={`${status.label}: ${status.count}`}
              />
            </div>
          );
        })}
      </Stack>
    </Card>
  );
}
