import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  CopyButton,
  Group,
  LoadingOverlay,
  Menu,
  Modal,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import {
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconDots,
  IconKey,
  IconLock,
  IconLockOpen,
  IconSearch,
  IconShieldCheck,
  IconShieldOff,
  IconUserPlus,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type ManagedUser, type NewUserInput } from "../api";
import { formatDate } from "../format";
import { ALL_ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, type PortalRole } from "../roles";
import { useUser } from "../session";

const fullName = (user: ManagedUser) => [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username;

function MfaBadge({ user }: { user: ManagedUser }) {
  if (user.mfa === "configured") return <Badge color="teal" variant="light" size="sm" leftSection={<IconShieldCheck size={12} />}>MFA on</Badge>;
  if (user.mfa === "required") return <Badge color="yellow" variant="light" size="sm">MFA at next sign-in</Badge>;
  return <Badge color="gray" variant="light" size="sm" leftSection={<IconShieldOff size={12} />}>No MFA</Badge>;
}

function RoleChoices(props: { value: PortalRole[]; onChange: (roles: PortalRole[]) => void; disabledRoles?: PortalRole[] }) {
  return (
    <Checkbox.Group label="Roles" value={props.value} onChange={(value) => props.onChange(value as PortalRole[])} withAsterisk>
      <Stack gap="xs" mt="xs">
        {ALL_ROLES.map((role) => (
          <Checkbox
            key={role}
            value={role}
            label={ROLE_LABELS[role]}
            description={ROLE_DESCRIPTIONS[role]}
            disabled={props.disabledRoles?.includes(role)}
          />
        ))}
      </Stack>
    </Checkbox.Group>
  );
}

/** Shown once: the portal never stores or shows the password again. */
function PasswordReveal(props: { user: ManagedUser; password: string; onClose: () => void }) {
  return (
    <Modal opened onClose={props.onClose} title="One-time password" centered closeOnClickOutside={false}>
      <Stack>
        <Text size="sm">
          Give this password to <b>{fullName(props.user)}</b> ({props.user.username}) in person or by phone. It works once:
          they must choose a new password when they sign in
          {props.user.mfa === "required" ? ", and set up an authenticator app" : ""}.
        </Text>
        <Group gap="xs" justify="center" py="sm">
          <Code fz="xl" p="sm">
            {props.password}
          </Code>
          <CopyButton value={props.password}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? "Copied" : "Copy"}>
                <ActionIcon variant="light" color={copied ? "teal" : "gray"} size="lg" onClick={copy} aria-label="Copy password">
                  {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        </Group>
        <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />}>
          This password will not be shown again. Do not send it by email together with the username.
        </Alert>
        <Button onClick={props.onClose}>Done</Button>
      </Stack>
    </Modal>
  );
}

const EMPTY_FORM: NewUserInput = { username: "", firstName: "", lastName: "", email: "", roles: [], requireMfa: true };

function AddUserModal(props: { onClose: () => void; onCreated: (user: ManagedUser, password: string) => void }) {
  const [form, setForm] = useState<NewUserInput>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const field = (key: "username" | "firstName" | "lastName" | "email") => ({
    value: form[key],
    onChange: (event: { currentTarget: { value: string } }) => setForm({ ...form, [key]: event.currentTarget.value }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    api
      .createUser(form)
      .then((result) => props.onCreated(result.user, result.temporaryPassword))
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  };

  return (
    <Modal opened onClose={props.onClose} title="Add a portal user" size="lg" centered>
      <form onSubmit={submit}>
        <Stack>
          {error && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />}>
              {error}
            </Alert>
          )}
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label="First name" required {...field("firstName")} data-autofocus />
            <TextInput label="Last name" required {...field("lastName")} />
            <TextInput label="Username" required description="Letters, digits, dot, dash" {...field("username")} />
            <TextInput label="Email" type="email" required {...field("email")} />
          </SimpleGrid>
          <RoleChoices value={form.roles} onChange={(roles) => setForm({ ...form, roles })} />
          <Switch
            label="Require an authenticator app (MFA)"
            description="Strongly recommended: this portal shows patient data."
            checked={form.requireMfa}
            onChange={(event) => setForm({ ...form, requireMfa: event.currentTarget.checked })}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={saving} disabled={!form.roles.length}>
              Create user
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function RolesModal(props: { user: ManagedUser; isSelf: boolean; onClose: () => void; onSaved: (user: ManagedUser) => void }) {
  const [roles, setRoles] = useState<PortalRole[]>(props.user.roles);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = () => {
    setSaving(true);
    setError(null);
    api
      .setUserRoles(props.user.id, roles)
      .then(props.onSaved)
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  };
  return (
    <Modal opened onClose={props.onClose} title={`Roles for ${fullName(props.user)}`} centered>
      <Stack>
        {error && (
          <Alert color="red" icon={<IconAlertTriangle size={18} />}>
            {error}
          </Alert>
        )}
        <RoleChoices value={roles} onChange={setRoles} disabledRoles={props.isSelf ? ["repo-admin"] : []} />
        {props.isSelf && (
          <Text size="xs" c="dimmed">
            You cannot remove your own administrator role.
          </Text>
        )}
        {roles.length === 0 && (
          <Text size="xs" c="orange">
            With no role, this person can sign in but sees nothing.
          </Text>
        )}
        <Text size="xs" c="dimmed">
          Takes effect on their next page load.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Save roles
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

interface Confirmation {
  title: string;
  message: string;
  action: string;
  color: string;
  run: () => Promise<void>;
}

function ConfirmModal(props: { confirmation: Confirmation; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = () => {
    setBusy(true);
    setError(null);
    props.confirmation
      .run()
      .then(props.onClose)
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };
  return (
    <Modal opened onClose={props.onClose} title={props.confirmation.title} centered>
      <Stack>
        {error && (
          <Alert color="red" icon={<IconAlertTriangle size={18} />}>
            {error}
          </Alert>
        )}
        <Text size="sm">{props.confirmation.message}</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            Cancel
          </Button>
          <Button color={props.confirmation.color} onClick={confirm} loading={busy}>
            {props.confirmation.action}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function UsersPage() {
  const me = useUser();
  const [search, setSearch] = useState("");
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingRoles, setEditingRoles] = useState<ManagedUser | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [reveal, setReveal] = useState<{ user: ManagedUser; password: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .users(debouncedSearch)
      .then((list) => {
        setUsers(list);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [debouncedSearch]);
  useEffect(load, [load]);

  const done = (message: string) => {
    setNotice(message);
    load();
  };

  const confirmDisable = (user: ManagedUser) =>
    setConfirmation({
      title: `Disable ${fullName(user)}?`,
      message: `${user.username} will be signed out of the portal within a minute and cannot sign in again until re-enabled. Their history is kept.`,
      action: "Disable account",
      color: "red",
      run: async () => {
        await api.setUserEnabled(user.id, false);
        done(`${user.username} is disabled.`);
      },
    });
  const confirmEnable = (user: ManagedUser) =>
    setConfirmation({
      title: `Enable ${fullName(user)}?`,
      message: `${user.username} will be able to sign in again with their existing password and roles.`,
      action: "Enable account",
      color: "teal",
      run: async () => {
        await api.setUserEnabled(user.id, true);
        done(`${user.username} is enabled.`);
      },
    });
  const confirmPasswordReset = (user: ManagedUser) =>
    setConfirmation({
      title: `Reset the password for ${fullName(user)}?`,
      message: "Their current password stops working and they are signed out. You will get a one-time password to give them.",
      action: "Reset password",
      color: "orange",
      run: async () => {
        const result = await api.resetUserPassword(user.id);
        setReveal({ user: result.user, password: result.temporaryPassword });
        done(`${user.username} has a new one-time password.`);
      },
    });
  const confirmMfaReset = (user: ManagedUser) =>
    setConfirmation({
      title: `Reset MFA for ${fullName(user)}?`,
      message: "Use this when someone has lost their phone. Their authenticator app is removed, they are signed out, and they set up a new one at their next sign-in.",
      action: "Reset MFA",
      color: "orange",
      run: async () => {
        await api.resetUserMfa(user.id);
        done(`${user.username} will set up a new authenticator app at next sign-in.`);
      },
    });

  const active = users?.filter((user) => user.enabled).length ?? 0;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>Users</Title>
          <Text c="dimmed" size="sm">
            Who can sign in to this portal, and what they can see. Accounts live in Keycloak.
          </Text>
        </div>
        <Button leftSection={<IconUserPlus size={16} />} onClick={() => setAdding(true)}>
          Add user
        </Button>
      </Group>

      {notice && (
        <Alert color="teal" icon={<IconCheck size={18} />} withCloseButton onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {error && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Could not load users">
          {error}
        </Alert>
      )}

      <Card withBorder padding={0} pos="relative">
        <LoadingOverlay visible={loading && !users} />
        <Group justify="space-between" p="md" gap="sm">
          <TextInput
            placeholder="Search by name, username or email"
            leftSection={<IconSearch size={16} />}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            w={{ base: "100%", sm: 340 }}
            aria-label="Search users"
          />
          {users && (
            <Group gap={6} c="dimmed">
              <IconUsersGroup size={16} />
              <Text size="sm">
                {users.length} user{users.length === 1 ? "" : "s"} · {active} active
              </Text>
            </Group>
          )}
        </Group>
        {users && users.length === 0 ? (
          <Text c="dimmed" ta="center" py="xl">
            {search ? "No users match this search." : "No users yet."}
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={820}>
            <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>User</Table.Th>
                  <Table.Th>Roles</Table.Th>
                  <Table.Th>Sign-in</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Added</Table.Th>
                  <Table.Th w={48} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(users ?? []).map((user) => {
                  const isSelf = user.id === me.sub;
                  return (
                    <Table.Tr key={user.id} style={{ opacity: user.enabled ? 1 : 0.6 }}>
                      <Table.Td>
                        <Group gap={6}>
                          <Text size="sm" fw={500}>
                            {fullName(user)}
                          </Text>
                          {isSelf && (
                            <Badge size="xs" variant="outline">
                              You
                            </Badge>
                          )}
                        </Group>
                        <Text size="xs" c="dimmed">
                          {user.username}
                          {user.email ? ` · ${user.email}` : ""}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4}>
                          {user.roles.length ? (
                            user.roles.map((role) => (
                              <Badge key={role} variant="light" size="sm">
                                {ROLE_LABELS[role]}
                              </Badge>
                            ))
                          ) : (
                            <Text size="xs" c="orange">
                              No portal role
                            </Text>
                          )}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Stack gap={4}>
                          <MfaBadge user={user} />
                          {user.passwordChangeRequired && (
                            <Text size="xs" c="dimmed">
                              Must set a password
                            </Text>
                          )}
                        </Stack>
                      </Table.Td>
                      <Table.Td>
                        <Badge color={user.enabled ? "teal" : "gray"} variant={user.enabled ? "light" : "outline"} size="sm">
                          {user.enabled ? "Active" : "Disabled"}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{formatDate(user.createdAt)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Menu position="bottom-end" withinPortal>
                          <Menu.Target>
                            <ActionIcon variant="subtle" color="gray" aria-label={`Actions for ${user.username}`}>
                              <IconDots size={18} />
                            </ActionIcon>
                          </Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Item leftSection={<IconUsersGroup size={16} />} onClick={() => setEditingRoles(user)}>
                              Change roles
                            </Menu.Item>
                            <Menu.Item leftSection={<IconKey size={16} />} onClick={() => confirmPasswordReset(user)}>
                              Reset password
                            </Menu.Item>
                            <Menu.Item
                              leftSection={<IconShieldOff size={16} />}
                              onClick={() => confirmMfaReset(user)}
                              disabled={user.mfa !== "configured"}
                            >
                              Reset MFA
                            </Menu.Item>
                            <Menu.Divider />
                            {user.enabled ? (
                              <Menu.Item
                                color="red"
                                leftSection={<IconLock size={16} />}
                                onClick={() => confirmDisable(user)}
                                disabled={isSelf}
                              >
                                Disable account
                              </Menu.Item>
                            ) : (
                              <Menu.Item leftSection={<IconLockOpen size={16} />} onClick={() => confirmEnable(user)}>
                                Enable account
                              </Menu.Item>
                            )}
                          </Menu.Dropdown>
                        </Menu>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

      <Text size="xs" c="dimmed">
        Accounts are disabled rather than deleted, so past activity stays attributable. Every change is logged with the
        administrator who made it, and in Keycloak's admin events.
      </Text>

      {adding && (
        <AddUserModal
          onClose={() => setAdding(false)}
          onCreated={(user, password) => {
            setAdding(false);
            setReveal({ user, password });
            done(`${user.username} was created.`);
          }}
        />
      )}
      {editingRoles && (
        <RolesModal
          user={editingRoles}
          isSelf={editingRoles.id === me.sub}
          onClose={() => setEditingRoles(null)}
          onSaved={(user) => {
            setEditingRoles(null);
            done(`Roles for ${user.username} were updated.`);
          }}
        />
      )}
      {confirmation && <ConfirmModal confirmation={confirmation} onClose={() => setConfirmation(null)} />}
      {reveal && <PasswordReveal user={reveal.user} password={reveal.password} onClose={() => setReveal(null)} />}
    </Stack>
  );
}
