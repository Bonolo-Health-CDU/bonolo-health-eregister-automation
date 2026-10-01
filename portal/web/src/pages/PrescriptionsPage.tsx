import {
  Alert,
  Anchor,
  Button,
  Card,
  Group,
  LoadingOverlay,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconAlertTriangle, IconChevronLeft, IconChevronRight, IconSearch, IconX } from "@tabler/icons-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api, type ReferenceLists, type SearchResult } from "../api";
import { StatusBadge } from "../components/StatusBadge";
import { formatDate } from "../format";

const FILTERS = ["eregisterId", "name", "orderId", "facility", "status", "from", "to"] as const;
type Filters = Record<(typeof FILTERS)[number], string>;

const filtersFrom = (params: URLSearchParams): Filters =>
  Object.fromEntries(FILTERS.map((key) => [key, params.get(key) ?? ""])) as Filters;

export function PrescriptionsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [form, setForm] = useState<Filters>(() => filtersFrom(params));
  const [reference, setReference] = useState<ReferenceLists | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.reference().then(setReference).catch(() => setReference({ facilities: [], pickupPoints: [], statuses: [] }));
  }, []);

  // The URL is the source of truth: searching, paging and the back button all go through it.
  const query = params.toString();
  useEffect(() => {
    setForm(filtersFrom(new URLSearchParams(query)));
    setLoading(true);
    setError(null);
    api
      .prescriptions(new URLSearchParams(query))
      .then(setResult)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [query]);

  const search = (event: FormEvent) => {
    event.preventDefault();
    const next = new URLSearchParams();
    for (const key of FILTERS) if (form[key].trim()) next.set(key, form[key].trim());
    setParams(next);
  };
  const goToPage = (cursor: string) => {
    const next = new URLSearchParams(params);
    next.set("cursor", cursor);
    setParams(next);
  };
  const field = (key: keyof Filters) => ({
    value: form[key],
    onChange: (event: { currentTarget: { value: string } }) =>
      setForm((current) => ({ ...current, [key]: event.currentTarget.value })),
  });
  const filtered = FILTERS.some((key) => params.get(key));
  const first = result ? result.offset + 1 : 0;
  const last = result ? result.offset + result.items.length : 0;

  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>Prescriptions</Title>
        <Text c="dimmed" size="sm">
          Find a prescription and follow it from the facility to the patient. Newest first.
        </Text>
      </div>

      <Card withBorder padding="lg" component="form" onSubmit={search}>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          <TextInput label="eRegister ID" placeholder="e.g. E0000000001/26" {...field("eregisterId")} />
          <TextInput label="Patient name" placeholder="First or last name" {...field("name")} />
          <Select
            label="Facility"
            placeholder="Any facility"
            data={reference?.facilities.map((item) => ({ value: item.id, label: item.name })) ?? []}
            value={form.facility || null}
            onChange={(value) => setForm((current) => ({ ...current, facility: value ?? "" }))}
            searchable
            clearable
          />
          <Select
            label="Status"
            placeholder="Any status"
            data={reference?.statuses.map((item) => ({ value: item.code, label: item.label })) ?? []}
            value={form.status || null}
            onChange={(value) => setForm((current) => ({ ...current, status: value ?? "" }))}
            clearable
          />
          <TextInput label="Order ID" placeholder="eRegister order UUID" {...field("orderId")} />
          <TextInput label="Written from" type="date" {...field("from")} />
          <TextInput label="Written to" type="date" {...field("to")} />
          <Group align="flex-end" gap="sm">
            <Button type="submit" leftSection={<IconSearch size={16} />}>
              Search
            </Button>
            {filtered && (
              <Button variant="subtle" color="gray" leftSection={<IconX size={16} />} onClick={() => setParams(new URLSearchParams())}>
                Clear
              </Button>
            )}
          </Group>
        </SimpleGrid>
      </Card>

      {error && (
        <Alert color="red" icon={<IconAlertTriangle />} title="Search failed">
          {error}
        </Alert>
      )}

      <Card withBorder padding={0} pos="relative">
        <LoadingOverlay visible={loading} overlayProps={{ blur: 1 }} />
        {result && result.items.length === 0 ? (
          <Text c="dimmed" ta="center" py="xl">
            {filtered ? "No prescriptions match these filters." : "No prescriptions have been published yet."}
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={760}>
            <Table highlightOnHover verticalSpacing="sm" horizontalSpacing="md">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Written</Table.Th>
                  <Table.Th>Patient</Table.Th>
                  <Table.Th>Facility</Table.Th>
                  <Table.Th>Pickup point</Table.Th>
                  <Table.Th>Regimen</Table.Th>
                  <Table.Th>Status</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(result?.items ?? []).map((item) => (
                  <Table.Tr
                    key={item.taskId}
                    style={{ cursor: "pointer" }}
                    onClick={() => navigate(`/prescriptions/${item.taskId}`)}
                  >
                    <Table.Td>{formatDate(item.authoredOn)}</Table.Td>
                    <Table.Td>
                      <Anchor
                        component={Link}
                        to={`/prescriptions/${item.taskId}`}
                        fw={500}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {item.patient.name ?? "Unnamed patient"}
                      </Anchor>
                      <Text size="xs" c="dimmed">
                        {item.patient.eregisterId ?? "No eRegister ID"}
                      </Text>
                    </Table.Td>
                    <Table.Td>{item.facility.name ?? "—"}</Table.Td>
                    <Table.Td>{item.pickupPoint.name ?? "—"}</Table.Td>
                    <Table.Td>
                      <Text size="sm">{item.regimen.code ?? "—"}</Text>
                      <Text size="xs" c="dimmed">
                        {item.regimen.display}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <StatusBadge status={item.status} size="sm" />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
        {result && result.items.length > 0 && (
          <Group justify="space-between" px="md" py="sm" style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
            <Text size="sm" c="dimmed">
              {first}–{last}
              {result.total !== null && ` of ${result.total.toLocaleString()}`}
            </Text>
            <Group gap="xs">
              <Button
                variant="default"
                size="xs"
                leftSection={<IconChevronLeft size={14} />}
                disabled={!result.previous}
                onClick={() => result.previous && goToPage(result.previous)}
              >
                Previous
              </Button>
              <Button
                variant="default"
                size="xs"
                rightSection={<IconChevronRight size={14} />}
                disabled={!result.next}
                onClick={() => result.next && goToPage(result.next)}
              >
                Next
              </Button>
            </Group>
          </Group>
        )}
      </Card>
    </Stack>
  );
}
