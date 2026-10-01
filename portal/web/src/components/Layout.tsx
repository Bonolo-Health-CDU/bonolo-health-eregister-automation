import {
  ActionIcon,
  AppShell,
  Avatar,
  Badge,
  Burger,
  Group,
  Menu,
  NavLink,
  Text,
  Title,
  Tooltip,
  UnstyledButton,
  useMantineColorScheme,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconActivityHeartbeat,
  IconChevronDown,
  IconLayoutDashboard,
  IconLogout,
  IconMoon,
  IconPrescription,
  IconSun,
  IconUsers,
} from "@tabler/icons-react";
import { NavLink as RouterLink, Outlet, useLocation } from "react-router";
import { api } from "../api";
import { canUse, ROLE_LABELS, type Feature } from "../roles";
import { useUser } from "../session";

const NAV: { feature: Feature; label: string; path: string; icon: typeof IconUsers; description: string }[] = [
  { feature: "dashboard", label: "Dashboard", path: "/", icon: IconLayoutDashboard, description: "Repository at a glance" },
  { feature: "prescriptions", label: "Prescriptions", path: "/prescriptions", icon: IconPrescription, description: "Search and trace" },
  { feature: "integrations", label: "Integration health", path: "/integrations", icon: IconActivityHeartbeat, description: "OpenHIM and FHIR server" },
  { feature: "users", label: "Users", path: "/users", icon: IconUsers, description: "Portal accounts and roles" },
];

export function Layout() {
  const user = useUser();
  const location = useLocation();
  const [navOpen, { toggle, close }] = useDisclosure(false);
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const initials = user.name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 260, breakpoint: "sm", collapsed: { mobile: !navOpen } }}
      padding="lg"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={navOpen} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Toggle navigation" />
            <IconPrescription size={26} color="var(--mantine-color-teal-6)" aria-hidden />
            <div>
              <Title order={4} lh={1.1}>
                Prescription Repository
              </Title>
              <Text size="xs" c="dimmed" visibleFrom="xs">
                Bonolo CDU · eRegister
              </Text>
            </div>
          </Group>

          <Group gap="xs" wrap="nowrap">
            <Tooltip label={colorScheme === "dark" ? "Light mode" : "Dark mode"}>
              <ActionIcon variant="subtle" color="gray" onClick={toggleColorScheme} aria-label="Toggle colour scheme">
                {colorScheme === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}
              </ActionIcon>
            </Tooltip>
            <Menu position="bottom-end" width={240}>
              <Menu.Target>
                <UnstyledButton aria-label="Account menu">
                  <Group gap={8} wrap="nowrap">
                    <Avatar color="teal" radius="xl" size="sm">
                      {initials}
                    </Avatar>
                    <Text size="sm" fw={500} visibleFrom="sm">
                      {user.name}
                    </Text>
                    <IconChevronDown size={14} />
                  </Group>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>
                  {user.username}
                  {user.email ? ` · ${user.email}` : ""}
                </Menu.Label>
                <Group gap={4} px="sm" pb="xs">
                  {user.roles.map((role) => (
                    <Badge key={role} variant="light" size="sm">
                      {ROLE_LABELS[role]}
                    </Badge>
                  ))}
                </Group>
                <Menu.Divider />
                <Menu.Item leftSection={<IconLogout size={16} />} onClick={() => void api.logout()}>
                  Sign out
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        {NAV.filter((item) => canUse(user.roles, item.feature)).map((item) => (
          <NavLink
            key={item.path}
            component={RouterLink}
            to={item.path}
            end={item.path === "/"}
            label={item.label}
            description={item.description}
            leftSection={<item.icon size={20} stroke={1.6} />}
            active={item.path === "/" ? location.pathname === "/" : location.pathname.startsWith(item.path)}
            onClick={close}
            mb={4}
          />
        ))}
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
