import { Card, Group, Text, ThemeIcon } from "@mantine/core";
import type { ReactNode } from "react";

export function StatCard(props: { label: string; value: number; color: string; icon: ReactNode; footer?: ReactNode }) {
  return (
    <Card withBorder padding="md" h="100%" style={{ display: "flex", flexDirection: "column" }}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Text size="sm" c="dimmed" fw={500}>
          {props.label}
        </Text>
        <ThemeIcon variant="light" color={props.color} radius="md">
          {props.icon}
        </ThemeIcon>
      </Group>
      <Text fz={32} fw={700} lh={1.2} mt="auto" pt={4}>
        {props.value.toLocaleString()}
      </Text>
      <div style={{ minHeight: 20, marginTop: 2 }}>{props.footer}</div>
    </Card>
  );
}
