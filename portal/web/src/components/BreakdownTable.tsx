import { Anchor, Card, Group, Table, Text, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { BreakdownRow, Stage } from "../api";
import { STAGES } from "../stages";

const COLUMNS: { stage: Stage; short: string }[] = [
  { stage: "waiting", short: "Waiting" },
  { stage: "atCdu", short: "At CDU" },
  { stage: "withFacility", short: "Returned" },
  { stage: "onTheWay", short: "Dispatched" },
  { stage: "completed", short: "Collected" },
  { stage: "cancelled", short: "Cancelled" },
];

const Count = ({ value }: { value: number }) =>
  value ? <>{value.toLocaleString()}</> : <Text span c="dimmed">–</Text>;

export function BreakdownTable(props: {
  title: string;
  subtitle: string;
  nameHeader: string;
  rows: BreakdownRow[];
  /** Where a row's name links to, if anywhere. */
  rowLink?: (row: BreakdownRow) => string | null;
}) {
  const [query, setQuery] = useState("");
  const rows = useMemo(
    () => props.rows.filter((row) => row.name.toLowerCase().includes(query.trim().toLowerCase())),
    [props.rows, query],
  );

  return (
    <Card withBorder padding="lg">
      <Group justify="space-between" align="flex-start" mb="sm">
        <div>
          <Text fw={600}>{props.title}</Text>
          <Text size="sm" c="dimmed">
            {props.subtitle}
          </Text>
        </div>
        {props.rows.length > 6 && (
          <TextInput
            size="xs"
            placeholder="Filter"
            aria-label={`Filter ${props.title.toLowerCase()}`}
            leftSection={<IconSearch size={14} />}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        )}
      </Group>
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed" py="md" ta="center">
          {props.rows.length ? "No match for this filter." : "No prescriptions in this period."}
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={640}>
          <Table striped highlightOnHover verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{props.nameHeader}</Table.Th>
                <Table.Th ta="right">Total</Table.Th>
                {COLUMNS.map((column) => (
                  <Table.Th key={column.stage} ta="right" title={STAGES[column.stage].hint}>
                    {column.short}
                  </Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <Table.Tr key={row.id}>
                  <Table.Td>
                    {props.rowLink?.(row) ? (
                      <Anchor component={Link} to={props.rowLink(row)!}>
                        {row.name}
                      </Anchor>
                    ) : (
                      row.name
                    )}
                  </Table.Td>
                  <Table.Td ta="right" fw={600}>
                    {row.total.toLocaleString()}
                  </Table.Td>
                  {COLUMNS.map((column) => (
                    <Table.Td key={column.stage} ta="right">
                      <Count value={row[column.stage]} />
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Card>
  );
}
