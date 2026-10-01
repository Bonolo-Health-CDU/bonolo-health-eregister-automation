import { Badge, Code, Table, Text, Tooltip } from "@mantine/core";
import type { ReactNode } from "react";
import type { TransactionRow } from "../api";
import { formatDateTime } from "../format";

export const httpColor = (status: number | null) =>
  status === null ? "red" : status >= 500 ? "red" : status >= 400 ? "orange" : status >= 300 ? "gray" : "teal";

export const HttpBadge = ({ status }: { status: number | null }) => (
  <Badge color={httpColor(status)} variant="light" size="sm">
    {status ?? "no response"}
  </Badge>
);

/** OpenHIM transactions as a compact table. `extra` adds trailing columns. */
export function TransactionTable<T extends TransactionRow>(props: {
  rows: T[];
  extra?: { header: string; cell: (row: T) => ReactNode }[];
  showChannel?: boolean;
}) {
  return (
    <Table.ScrollContainer minWidth={720}>
      <Table verticalSpacing="xs" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>When</Table.Th>
            <Table.Th>Client</Table.Th>
            <Table.Th>Request</Table.Th>
            <Table.Th>HTTP</Table.Th>
            {props.showChannel && <Table.Th>Channel</Table.Th>}
            {props.extra?.map((column) => <Table.Th key={column.header}>{column.header}</Table.Th>)}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {props.rows.map((row) => (
            <Table.Tr key={row.id}>
              <Table.Td style={{ whiteSpace: "nowrap" }}>
                <Text size="sm">{formatDateTime(row.at)}</Text>
                {row.durationMs !== null && (
                  <Text size="xs" c="dimmed">
                    {row.durationMs} ms
                  </Text>
                )}
              </Table.Td>
              <Table.Td>
                <Badge variant="outline" color="gray" size="sm" tt="none">
                  {row.client}
                </Badge>
              </Table.Td>
              <Table.Td maw={360}>
                <Tooltip label={row.path} disabled={row.path.length < 60} multiline maw={480}>
                  <Code style={{ wordBreak: "break-all" }}>
                    {row.method} {row.path.length > 80 ? `${row.path.slice(0, 80)}…` : row.path}
                  </Code>
                </Tooltip>
              </Table.Td>
              <Table.Td>
                <HttpBadge status={row.httpStatus} />
              </Table.Td>
              {props.showChannel && (
                <Table.Td>
                  <Text size="sm">{row.channel ?? "—"}</Text>
                </Table.Td>
              )}
              {props.extra?.map((column) => <Table.Td key={column.header}>{column.cell(row)}</Table.Td>)}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
