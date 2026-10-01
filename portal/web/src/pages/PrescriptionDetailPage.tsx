import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  CopyButton,
  Grid,
  Group,
  Skeleton,
  Stack,
  Table,
  Text,
  Timeline,
  Title,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconBuildingHospital,
  IconBuildingWarehouse,
  IconCheck,
  IconCopy,
} from "@tabler/icons-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { ApiError, api, type PrescriptionDetail, type TransactionRow } from "../api";
import { NotFound } from "../components/Messages";
import { StatusBadge } from "../components/StatusBadge";
import { TransactionTable } from "../components/TransactionTable";
import { age, formatDate, formatDateTime } from "../format";
import { STAGES } from "../stages";

/** A label/value list; empty values show a dash so gaps in the data are visible. */
function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <Table variant="vertical" layout="fixed" withRowBorders={false} verticalSpacing={6}>
      <Table.Tbody>
        {rows.map(([label, value]) => (
          <Table.Tr key={label}>
            <Table.Th w="42%" fw={500} c="dimmed" style={{ background: "none" }}>
              {label}
            </Table.Th>
            <Table.Td style={{ whiteSpace: "pre-line" }}>{value ?? "—"}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

const Section = (props: { title: string; children: ReactNode; extra?: ReactNode }) => (
  <Card withBorder padding="lg">
    <Group justify="space-between" mb="xs">
      <Text fw={600}>{props.title}</Text>
      {props.extra}
    </Group>
    {props.children}
  </Card>
);

const GENDER: Record<string, string> = { female: "Female", male: "Male", other: "Other", unknown: "Unknown" };

export function PrescriptionDetailPage() {
  const { taskId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [detail, setDetail] = useState<PrescriptionDetail | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [transactions, setTransactions] = useState<TransactionRow[] | string | null>(null);

  // Loaded separately: the page should not wait for OpenHIM.
  useEffect(() => {
    setTransactions(null);
    api
      .prescriptionTransactions(taskId)
      .then((result) => setTransactions(result.items))
      .catch((err: Error) => setTransactions(err.message));
  }, [taskId]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    api
      .prescription(taskId)
      .then(setDetail)
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? { status: err.status, message: err.message } : { status: 0, message: String(err) }),
      );
  }, [taskId]);

  // Back to the exact result page the user came from, when there is one.
  const back = () => (location.key !== "default" ? navigate(-1) : navigate("/prescriptions"));

  if (error?.status === 404) return <NotFound />;

  const header = (
    <Button variant="subtle" color="gray" leftSection={<IconArrowLeft size={16} />} onClick={back} w="fit-content" px={4}>
      Back to prescriptions
    </Button>
  );

  if (error) {
    return (
      <Stack>
        {header}
        <Alert color="red" icon={<IconAlertTriangle />} title="Could not load this prescription">
          {error.message}
        </Alert>
      </Stack>
    );
  }
  if (!detail) {
    return (
      <Stack>
        {header}
        <Skeleton h={80} />
        <Grid>
          <Grid.Col span={{ base: 12, md: 7 }}>
            <Skeleton h={420} />
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 5 }}>
            <Skeleton h={420} />
          </Grid.Col>
        </Grid>
      </Stack>
    );
  }

  const { summary, patient, prescription, fulfilment } = detail;
  const years = age(patient.birthDate);

  return (
    <Stack gap="lg">
      {header}

      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="sm">
            <Title order={2}>{patient.name ?? "Unnamed patient"}</Title>
            <StatusBadge status={summary.status} size="lg" />
          </Group>
          <Group gap={6} mt={4}>
            <Text size="sm" c="dimmed">
              Order {summary.orderId ?? "—"}
            </Text>
            {summary.orderId && (
              <CopyButton value={summary.orderId}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? "Copied" : "Copy order ID"}>
                    <ActionIcon variant="subtle" color={copied ? "teal" : "gray"} size="sm" onClick={copy} aria-label="Copy order ID">
                      {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                    </ActionIcon>
                  </Tooltip>
                )}
              </CopyButton>
            )}
            <Text size="sm" c="dimmed">
              · written {formatDate(summary.authoredOn)} at {summary.facility.name ?? "an unknown facility"}
            </Text>
          </Group>
        </div>
      </Group>

      {fulfilment.statusReason && (
        <Alert
          color={STAGES[summary.status.stage].color}
          icon={<IconAlertTriangle />}
          title={summary.status.code === "returned-to-facility" ? "Returned to the facility" : "Reason given by the CDU"}
        >
          {fulfilment.statusReason}
        </Alert>
      )}
      {prescription.status === "cancelled" && (
        <Alert color="gray" icon={<IconAlertTriangle />} title="Cancelled in eRegister">
          The facility cancelled this prescription.
        </Alert>
      )}

      <Grid>
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Stack>
            <Section title="Prescription">
              <Facts
                rows={[
                  ["Regimen", summary.regimen.code ? `${summary.regimen.code} · ${summary.regimen.display ?? ""}` : null],
                  ["Dosage", prescription.dosage],
                  ["Supply", prescription.supplyDays ? `${prescription.supplyDays} days` : null],
                  ["Repeats allowed", prescription.repeatsAllowed ?? null],
                  ["Prescriber", prescription.prescriber],
                  ["Facility", summary.facility.name],
                  ["Written", formatDate(summary.authoredOn)],
                  ["Pickup point", summary.pickupPoint.name],
                  ["Requested pickup date", formatDate(prescription.requestedPickupDate)],
                  ["Next clinical visit", formatDate(prescription.nextClinicalVisitDate)],
                  ["Programme", prescription.category],
                ]}
              />
            </Section>

            <Section title="At the CDU">
              <Facts
                rows={[
                  ["Status", <StatusBadge key="s" status={summary.status} size="sm" />],
                  ["Task status", <Badge key="t" variant="outline" color="gray" size="sm">{fulfilment.taskStatus}</Badge>],
                  ["Reason", fulfilment.statusReason],
                  ["Fulfilled by", fulfilment.owner],
                  ["Last change", formatDateTime(fulfilment.lastUpdated)],
                ]}
              />
            </Section>

            <Section title="Dispensed">
              {detail.dispenses.length === 0 ? (
                <Text size="sm" c="dimmed">
                  The CDU has not recorded a dispense yet.
                </Text>
              ) : (
                <Table.ScrollContainer minWidth={480}>
                  <Table verticalSpacing="xs">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Prepared</Table.Th>
                        <Table.Th>Quantity</Table.Th>
                        <Table.Th>Days</Table.Th>
                        <Table.Th>Handed over</Table.Th>
                        <Table.Th>Status</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {detail.dispenses.map((dispense) => (
                        <Table.Tr key={dispense.id}>
                          <Table.Td>{formatDateTime(dispense.whenPrepared)}</Table.Td>
                          <Table.Td>{dispense.quantity ?? "—"}</Table.Td>
                          <Table.Td>{dispense.daysSupply ?? "—"}</Table.Td>
                          <Table.Td>{formatDateTime(dispense.whenHandedOver)}</Table.Td>
                          <Table.Td>{dispense.status ?? "—"}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              )}
            </Section>
          </Stack>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 5 }}>
          <Stack>
            <Section title="Patient">
              <Facts
                rows={[
                  ["eRegister ID", patient.eregisterId],
                  ["HIV programme ID", patient.hivProgramId],
                  ["National ID", patient.nationalId],
                  ["Sex", patient.gender ? (GENDER[patient.gender] ?? patient.gender) : null],
                  ["Date of birth", patient.birthDate ? `${formatDate(patient.birthDate)}${years !== null ? ` (${years} years)` : ""}` : null],
                  ["Phone", patient.phones.length ? patient.phones.map((phone) => (
                    <Anchor key={phone} href={`tel:${phone}`} display="block">{phone}</Anchor>
                  )) : null],
                  ["Address", patient.address],
                  [
                    "Allergies",
                    detail.allergies.length
                      ? detail.allergies.map((allergy) => (
                          <Badge key={allergy.label} color="red" variant="light" mr={4}>
                            {allergy.label}
                          </Badge>
                        ))
                      : detail.noKnownAllergies
                        ? "No known allergies"
                        : "Not recorded",
                  ],
                ]}
              />
            </Section>

            <Section title="History">
              <Timeline bulletSize={26} lineWidth={2} active={detail.timeline.length - 1}>
                {detail.timeline.map((event, index) => (
                  <Timeline.Item
                    key={`${event.at}-${index}`}
                    color={event.stage ? STAGES[event.stage].color : "gray"}
                    bullet={event.actor === "CDU" ? <IconBuildingWarehouse size={14} /> : <IconBuildingHospital size={14} />}
                    title={event.title}
                  >
                    {event.detail && (
                      <Text size="sm" mt={2}>
                        {event.detail}
                      </Text>
                    )}
                    <Text size="xs" c="dimmed" mt={2}>
                      {formatDateTime(event.at)} · {event.actor === "CDU" ? "CDU" : "Facility (eRegister)"}
                    </Text>
                  </Timeline.Item>
                ))}
              </Timeline>
            </Section>
          </Stack>
        </Grid.Col>
      </Grid>

      <Section title="OpenHIM transactions">
        <Text size="sm" c="dimmed" mb="sm">
          Every request that created or changed this prescription, as recorded by OpenHIM
        </Text>
        {transactions === null ? (
          <Skeleton h={80} />
        ) : typeof transactions === "string" ? (
          <Text size="sm" c="red">
            {transactions}
          </Text>
        ) : transactions.length === 0 ? (
          <Text size="sm" c="dimmed">
            OpenHIM has no recorded requests for this prescription (they may have been removed by OpenHIM's retention).
          </Text>
        ) : (
          <TransactionTable rows={transactions} showChannel />
        )}
      </Section>

      <Text size="xs" c="dimmed">
        FHIR Task/{summary.taskId} (version {fulfilment.version ?? "?"}) · MedicationRequest/{prescription.id ?? "?"} ·
        Patient/{patient.id ?? "?"} · <Anchor component={Link} to="/prescriptions" size="xs">New search</Anchor>
      </Text>
    </Stack>
  );
}
