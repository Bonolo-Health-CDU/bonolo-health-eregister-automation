import {
  Accordion,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  List,
  Popover,
  SegmentedControl,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconFileCertificate,
  IconRefresh,
  IconRoute,
  IconServer,
} from "@tabler/icons-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type HealthWindow, type IntegrationHealth, type ProblemCategory } from "../api";
import { StatCard } from "../components/StatCard";
import { TransactionTable } from "../components/TransactionTable";
import { duration, timeAgo } from "../format";

const WINDOWS = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
];

const CATEGORIES: Record<ProblemCategory, { label: string; color: string }> = {
  "contract-rejection": { label: "Contract rejection", color: "orange" },
  refused: { label: "Refused", color: "red" },
  "not-found": { label: "Not found", color: "gray" },
  "version-conflict": { label: "Version conflict", color: "yellow" },
  "client-error": { label: "Bad request", color: "orange" },
  "server-error": { label: "Server error", color: "red" },
};

function HealthCard(props: { title: string; icon: ReactNode; ok: boolean | null; children: ReactNode }) {
  return (
    <Card withBorder padding="lg">
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <ThemeIcon variant="light" color="gray">
            {props.icon}
          </ThemeIcon>
          <Text fw={600}>{props.title}</Text>
        </Group>
        {props.ok === null ? null : props.ok ? (
          <Badge color="teal" variant="light" leftSection={<IconCircleCheck size={12} />}>
            Up
          </Badge>
        ) : (
          <Badge color="red" variant="light" leftSection={<IconCircleX size={12} />}>
            Down
          </Badge>
        )}
      </Group>
      {props.children}
    </Card>
  );
}

export function IntegrationsPage() {
  const [range, setRange] = useState<HealthWindow>("24h");
  const [health, setHealth] = useState<IntegrationHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (fresh = false) => {
      setLoading(true);
      setError(null);
      api
        .integrations(range, fresh)
        .then(setHealth)
        .catch((err: Error) => setError(err.message))
        .finally(() => setLoading(false));
    },
    [range],
  );
  useEffect(() => load(), [load]);

  const h = health;
  const windowLabel = range === "24h" ? "the last 24 hours" : "the last 7 days";
  const errors = h ? h.clients.reduce((sum, client) => sum + client.clientErrors + client.serverErrors, 0) : 0;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>Integration health</Title>
          <Text c="dimmed" size="sm">
            OpenHIM, the FHIR repository, and the traffic between eRegister, the CDU and the repository
            {h && ` · updated ${new Date(h.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
          </Text>
        </div>
        <Group gap="sm">
          <SegmentedControl data={WINDOWS} value={range} onChange={(value) => setRange(value as HealthWindow)} aria-label="Time window" />
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => load(true)} loading={loading}>
            Refresh
          </Button>
        </Group>
      </Group>

      {error && (
        <Alert color="red" icon={<IconAlertTriangle />} title="Could not load integration health">
          {error}
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, md: 3 }}>
        {!h ? (
          Array.from({ length: 3 }, (_, i) => <Skeleton key={i} h={130} radius="md" />)
        ) : (
          <>
            <HealthCard title="OpenHIM" icon={<IconRoute size={18} />} ok={h.openhim.reachable}>
              {h.openhim.reachable ? (
                <Text size="sm" c="dimmed">
                  Core {h.openhim.version ?? "?"} · up {duration(h.openhim.uptimeSeconds)}
                </Text>
              ) : (
                <Text size="sm" c="red">
                  {h.openhim.error}
                </Text>
              )}
            </HealthCard>
            <HealthCard title="FHIR repository" icon={<IconServer size={18} />} ok={h.fhir.reachable}>
              {h.fhir.reachable ? (
                <Text size="sm" c="dimmed">
                  {h.fhir.software} {h.fhir.version} · FHIR {h.fhir.fhirVersion} · {h.fhir.latencyMs} ms via OpenHIM
                </Text>
              ) : (
                <Text size="sm" c="red">
                  {h.fhir.error}
                </Text>
              )}
            </HealthCard>
            <HealthCard title="Contract (IG)" icon={<IconFileCertificate size={18} />} ok={null}>
              {h.contract.profiles.length ? (
                <Group gap="xs">
                  <Text size="sm" c="dimmed">
                    Version {h.contract.version ?? "?"} installed ·
                  </Text>
                  <Popover width={360} position="bottom" withArrow shadow="md">
                    <Popover.Target>
                      <Button variant="subtle" size="compact-sm">
                        {h.contract.profiles.length} profiles and extensions
                      </Button>
                    </Popover.Target>
                    <Popover.Dropdown>
                      <List size="sm" spacing={4}>
                        {h.contract.profiles.map((profile) => (
                          <List.Item key={profile.url}>
                            {profile.name}{" "}
                            <Text span size="xs" c="dimmed">
                              {profile.version} · {profile.status}
                            </Text>
                          </List.Item>
                        ))}
                      </List>
                    </Popover.Dropdown>
                  </Popover>
                </Group>
              ) : (
                <Text size="sm" c="red">
                  No Bonolo profiles found on the FHIR server. Requests are not being validated against the contract.
                </Text>
              )}
            </HealthCard>
          </>
        )}
      </SimpleGrid>

      {h && h.openhim.reachable && (
        <>
          <SimpleGrid cols={{ base: 2, lg: 4 }}>
            <StatCard
              label={`Requests, ${windowLabel}`}
              value={h.clients.reduce((sum, client) => sum + client.requests, 0)}
              color="gray"
              icon={<IconRoute size={18} />}
            />
            <StatCard
              label="Failed or rejected"
              value={errors}
              color={errors ? "orange" : "teal"}
              icon={<IconAlertTriangle size={18} />}
            />
            <StatCard
              label="Contract rejections"
              value={h.contractRejections}
              color={h.contractRejections ? "orange" : "teal"}
              icon={<IconFileCertificate size={18} />}
              footer={<Text size="xs" c="dimmed">Messages that broke the IG rules</Text>}
            />
            <StatCard
              label="CDU status publications"
              value={h.statusPublications.total}
              color={h.statusPublications.failed ? "red" : "teal"}
              icon={<IconCircleCheck size={18} />}
              footer={
                <Text size="xs" c={h.statusPublications.failed ? "red" : "dimmed"}>
                  {h.statusPublications.failed} failed
                </Text>
              }
            />
          </SimpleGrid>

          <Card withBorder padding="lg">
            <Text fw={600}>Clients</Text>
            <Text size="sm" c="dimmed" mb="sm">
              Systems that talk to the repository through OpenHIM, in {windowLabel}
            </Text>
            <Table.ScrollContainer minWidth={640}>
              <Table verticalSpacing="xs" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Client</Table.Th>
                    <Table.Th ta="right">Requests</Table.Th>
                    <Table.Th ta="right">Rejected (4xx)</Table.Th>
                    <Table.Th ta="right">Failed (5xx)</Table.Th>
                    <Table.Th>Last request</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {h.clients.map((client) => (
                    <Table.Tr key={client.clientId}>
                      <Table.Td>
                        <Text size="sm" fw={500}>
                          {client.name}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {client.clientId} · role {client.roles.join(", ")}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">{client.requests.toLocaleString()}</Table.Td>
                      <Table.Td ta="right" c={client.clientErrors ? "orange" : "dimmed"}>
                        {client.clientErrors}
                      </Table.Td>
                      <Table.Td ta="right" c={client.serverErrors ? "red" : "dimmed"}>
                        {client.serverErrors}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{timeAgo(client.lastSeen)}</Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Card>

          <Card withBorder padding="lg">
            <Text fw={600}>Failed and rejected requests</Text>
            <Text size="sm" c="dimmed" mb="sm">
              The latest 50 in {windowLabel}, with the server's own explanation
            </Text>
            {h.problems.length === 0 ? (
              <Group gap="xs" py="md" justify="center">
                <IconCircleCheck size={18} color="var(--mantine-color-teal-6)" aria-hidden />
                <Text size="sm" c="dimmed">
                  No failed or rejected requests in {windowLabel}.
                </Text>
              </Group>
            ) : (
              <TransactionTable
                rows={h.problems}
                extra={[
                  {
                    header: "Problem",
                    cell: (problem) => (
                      <Stack gap={4} maw={420}>
                        <Badge color={CATEGORIES[problem.category].color} variant="light" size="sm" w="fit-content">
                          {CATEGORIES[problem.category].label}
                        </Badge>
                        {problem.diagnostics && (
                          <Text size="xs" style={{ wordBreak: "break-word" }}>
                            {problem.diagnostics}
                          </Text>
                        )}
                      </Stack>
                    ),
                  },
                ]}
              />
            )}
          </Card>

          <Accordion variant="contained">
            <Accordion.Item value="channels">
              <Accordion.Control>
                <Text fw={600}>Channels ({h.channels.length})</Text>
                <Text size="xs" c="dimmed">
                  What each client may do. Change these in the OpenHIM console.
                </Text>
              </Accordion.Control>
              <Accordion.Panel>
                <Table.ScrollContainer minWidth={640}>
                  <Table verticalSpacing="xs">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Channel</Table.Th>
                        <Table.Th>Methods</Table.Th>
                        <Table.Th>Allowed roles</Table.Th>
                        <Table.Th>Status</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {h.channels.map((channel) => (
                        <Table.Tr key={channel.name}>
                          <Table.Td>
                            <Text size="sm">{channel.name}</Text>
                            <Text size="xs" c="dimmed" ff="monospace">
                              {channel.urlPattern}
                            </Text>
                          </Table.Td>
                          <Table.Td>{channel.methods.join(", ")}</Table.Td>
                          <Table.Td>
                            <Group gap={4}>
                              {channel.allow.map((role) => (
                                <Badge key={role} size="sm" variant="outline" color="gray" tt="none">
                                  {role}
                                </Badge>
                              ))}
                            </Group>
                          </Table.Td>
                          <Table.Td>
                            <Badge size="sm" color={channel.status === "enabled" ? "teal" : "gray"} variant="light">
                              {channel.status}
                            </Badge>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        </>
      )}
    </Stack>
  );
}
