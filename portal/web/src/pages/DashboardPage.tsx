import { BarChart } from "@mantine/charts";
import {
  Alert,
  Badge,
  Button,
  Card,
  Grid,
  Group,
  SegmentedControl,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconBan,
  IconBuildingWarehouse,
  IconClockHour4,
  IconCircleCheck,
  IconFileDescription,
  IconRefresh,
  IconTruckDelivery,
} from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api, type Dashboard, type IntegrationHealth, type SystemStatus } from "../api";
import { BreakdownTable } from "../components/BreakdownTable";
import { StatCard } from "../components/StatCard";
import { StatusPipeline } from "../components/StatusPipeline";
import { canUse } from "../roles";
import { useUser } from "../session";
import { STAGES } from "../stages";

const PERIODS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "12 months" },
];
const PERIOD_KEY = "portal.dashboard.days";

function storedPeriod(): string {
  try {
    const value = localStorage.getItem(PERIOD_KEY);
    return PERIODS.some((period) => period.value === value) ? value! : "30";
  } catch {
    return "30";
  }
}

const dayLabel = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export function DashboardPage() {
  const user = useUser();
  const canSearch = canUse(user.roles, "prescriptions");
  const canSeeIntegrations = canUse(user.roles, "integrations");
  const [integrations, setIntegrations] = useState<IntegrationHealth | null>(null);
  const [days, setDays] = useState(storedPeriod);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(
    (fresh = false) => {
      setLoading(true);
      setFailed(false);
      Promise.all([api.dashboard(Number(days), fresh), api.systemStatus()])
        .then(([nextDashboard, nextStatus]) => {
          setDashboard(nextDashboard);
          setStatus(nextStatus);
        })
        .catch(() => setFailed(true))
        .finally(() => setLoading(false));
    },
    [days],
  );

  useEffect(() => load(), [load]);

  // Integration problems are for the people who can act on them; never block the dashboard on OpenHIM.
  useEffect(() => {
    if (canSeeIntegrations) api.integrations("24h").then(setIntegrations).catch(() => setIntegrations(null));
  }, [canSeeIntegrations]);
  const integrationProblems = integrations
    ? integrations.clients.reduce((sum, client) => sum + client.clientErrors + client.serverErrors, 0)
    : 0;

  const changePeriod = (value: string) => {
    setDays(value);
    try {
      localStorage.setItem(PERIOD_KEY, value);
    } catch {
      // Private browsing: the choice just isn't remembered.
    }
  };

  const d = dashboard;
  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end" gap="sm">
        <div>
          <Title order={2}>Dashboard</Title>
          <Text c="dimmed" size="sm">
            Prescriptions published by facilities in the selected period
            {d && ` (${dayLabel(d.period.since)} – ${dayLabel(d.period.until)})`}
            {d && ` · updated ${new Date(d.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
          </Text>
        </div>
        <Group gap="sm">
          <SegmentedControl data={PERIODS} value={days} onChange={changePeriod} aria-label="Period" />
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => load(true)} loading={loading}>
            Refresh
          </Button>
        </Group>
      </Group>

      {failed && (
        <Alert color="red" icon={<IconAlertTriangle />} title="Could not load the dashboard">
          The FHIR repository did not answer through OpenHIM. Check Integration health, then try again.
        </Alert>
      )}
      {d && d.unclaimedOverThreshold > 0 && (
        <Alert color="orange" icon={<IconClockHour4 />} title="Prescriptions waiting too long">
          {d.unclaimedOverThreshold} prescription{d.unclaimedOverThreshold === 1 ? " has" : "s have"} been waiting for
          the CDU for more than {d.unclaimedHours} hours. The CDU normally picks prescriptions up within minutes. Check
          that its integration is running.
          {canSearch && (
            <Button component={Link} to="/prescriptions?status=sent-to-cdu" size="xs" variant="light" color="orange" mt="sm" display="block" w="fit-content">
              Show waiting prescriptions
            </Button>
          )}
        </Alert>
      )}
      {integrations && (integrationProblems > 0 || !integrations.openhim.reachable || !integrations.fhir.reachable) && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle />} title="Integration problems in the last 24 hours">
          {!integrations.openhim.reachable || !integrations.fhir.reachable
            ? "OpenHIM or the FHIR repository is not reachable."
            : `${integrationProblems} request${integrationProblems === 1 ? " was" : "s were"} rejected or failed` +
              ` (${integrations.contractRejections} contract rejection${integrations.contractRejections === 1 ? "" : "s"},` +
              ` ${integrations.statusPublications.failed} failed CDU status publication${integrations.statusPublications.failed === 1 ? "" : "s"}).`}
          <Button component={Link} to="/integrations" size="xs" variant="light" color="red" mt="sm" display="block" w="fit-content">
            Open integration health
          </Button>
        </Alert>
      )}
      {d?.truncated && (
        <Alert color="yellow" icon={<IconAlertTriangle />}>
          This period has more prescriptions than the dashboard reads at once, so the figures are partial. Choose a
          shorter period.
        </Alert>
      )}

      <SimpleGrid cols={{ base: 2, md: 3, xl: 6 }}>
        {!d ? (
          Array.from({ length: 6 }, (_, i) => <Skeleton key={i} h={118} radius="md" />)
        ) : (
          <>
            <StatCard label="Published" value={d.total} color="gray" icon={<IconFileDescription size={18} />} />
            <StatCard
              label={STAGES.waiting.label}
              value={d.stages.waiting}
              color={STAGES.waiting.color}
              icon={<IconClockHour4 size={18} />}
              footer={
                d.unclaimedOverThreshold > 0 ? (
                  <Badge color="orange" variant="light" size="sm">
                    {d.unclaimedOverThreshold} over {d.unclaimedHours} h
                  </Badge>
                ) : undefined
              }
            />
            <StatCard
              label={STAGES.atCdu.label}
              value={d.stages.atCdu}
              color={STAGES.atCdu.color}
              icon={<IconBuildingWarehouse size={18} />}
            />
            <StatCard
              label={STAGES.withFacility.label}
              value={d.stages.withFacility}
              color={STAGES.withFacility.color}
              icon={<IconArrowBackUp size={18} />}
            />
            <StatCard
              label="Dispatched or collected"
              value={d.stages.onTheWay + d.stages.completed}
              color={STAGES.onTheWay.color}
              icon={<IconTruckDelivery size={18} />}
            />
            <StatCard
              label={STAGES.cancelled.label}
              value={d.stages.cancelled}
              color={STAGES.cancelled.color}
              icon={<IconBan size={18} />}
              footer={
                d.stages.cancelled > 0 ? (
                  <Text size="xs" c="dimmed">
                    {d.cancelled.byFacility} by facility · {d.cancelled.byCdu} by CDU
                  </Text>
                ) : undefined
              }
            />
          </>
        )}
      </SimpleGrid>

      {d && d.total === 0 && (
        <Card withBorder padding="xl">
          <Stack align="center" gap={4}>
            <Text fw={600}>No prescriptions in this period</Text>
            <Text size="sm" c="dimmed">
              Facilities have not published any prescriptions since {dayLabel(d.period.since)}.
            </Text>
          </Stack>
        </Card>
      )}

      {d && d.total > 0 && (
        <>
          <Grid>
            <Grid.Col span={{ base: 12, lg: 5 }}>
              <StatusPipeline dashboard={d} />
            </Grid.Col>
            <Grid.Col span={{ base: 12, lg: 7 }}>
              <Card withBorder padding="lg" h="100%">
                <Text fw={600}>Prescriptions published per day</Text>
                <Text size="sm" c="dimmed" mb="md">
                  By the date the facility wrote the prescription
                </Text>
                <BarChart
                  h={280}
                  data={d.daily.map((day) => ({ day: dayLabel(day.date), Prescriptions: day.count }))}
                  dataKey="day"
                  series={[{ name: "Prescriptions", color: "teal.6" }]}
                  yAxisProps={{ allowDecimals: false }}
                  xAxisProps={{ interval: "preserveStartEnd", minTickGap: 16 }}
                />
              </Card>
            </Grid.Col>
          </Grid>

          <BreakdownTable
            title="By facility"
            subtitle="The facility that wrote and published the prescription"
            nameHeader="Facility"
            rows={d.facilities}
            rowLink={canSearch ? (row) => (row.id === "unknown" ? null : `/prescriptions?facility=${encodeURIComponent(row.id)}`) : undefined}
          />
          <BreakdownTable
            title="By pickup point"
            subtitle="Where patients collect their medicine"
            nameHeader="Pickup point"
            rows={d.pickupPoints}
          />
        </>
      )}

      {status && (
        <Group gap="xs" c="dimmed">
          {status.fhir.reachable ? (
            <>
              <IconCircleCheck size={16} color="var(--mantine-color-teal-6)" aria-hidden />
              <Text size="xs">
                FHIR repository connected via {status.fhir.via} · {status.fhir.software} {status.fhir.softwareVersion} ·
                FHIR {status.fhir.fhirVersion} · {status.fhir.latencyMs} ms
              </Text>
            </>
          ) : (
            <>
              <IconAlertTriangle size={16} color="var(--mantine-color-red-6)" aria-hidden />
              <Text size="xs">{status.fhir.error}</Text>
            </>
          )}
        </Group>
      )}
    </Stack>
  );
}
