import { Button, Center, Loader, Paper, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { IconAlertTriangle, IconLock, IconMapQuestion } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { api, signIn } from "../api";

function MessageCard(props: { icon: ReactNode; color: string; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Center mih="60vh" p="md">
      <Paper withBorder p="xl" maw={480} w="100%">
        <Stack align="center" ta="center" gap="sm">
          <ThemeIcon size={48} radius="xl" variant="light" color={props.color}>
            {props.icon}
          </ThemeIcon>
          <Title order={3}>{props.title}</Title>
          <Text c="dimmed">{props.children}</Text>
          {props.action}
        </Stack>
      </Paper>
    </Center>
  );
}

export const FullPageLoader = () => (
  <Center mih="100vh">
    <Loader aria-label="Loading" />
  </Center>
);

const LOGIN_ERRORS: Record<string, string> = {
  access_denied: "Sign-in was cancelled.",
  invalid_login_state: "The sign-in link expired or was opened in another tab. Please try again.",
  sign_in_failed: "Keycloak could not confirm your sign-in. Please try again.",
};

export const LoginError = ({ reason }: { reason: string }) => (
  <MessageCard
    icon={<IconAlertTriangle />}
    color="orange"
    title="Sign-in did not complete"
    action={<Button onClick={() => signIn("/")}>Sign in again</Button>}
  >
    {LOGIN_ERRORS[reason] ?? "Something went wrong during sign-in."}
  </MessageCard>
);

export const ServerUnavailable = ({ message }: { message: string }) => (
  <MessageCard
    icon={<IconAlertTriangle />}
    color="red"
    title="Portal unavailable"
    action={<Button onClick={() => window.location.reload()}>Retry</Button>}
  >
    {message}
  </MessageCard>
);

export const NoRole = () => (
  <MessageCard
    icon={<IconLock />}
    color="gray"
    title="No portal access yet"
    action={
      <Button variant="default" onClick={() => void api.logout()}>
        Sign out
      </Button>
    }
  >
    Your account is signed in but has no portal role. Ask a repository administrator to assign you one.
  </MessageCard>
);

export const Forbidden = () => (
  <MessageCard
    icon={<IconLock />}
    color="gray"
    title="Not available for your role"
    action={
      <Button component={Link} to="/" variant="default">
        Back to dashboard
      </Button>
    }
  >
    This part of the portal is restricted. Ask a repository administrator if you need access.
  </MessageCard>
);

export const NotFound = () => (
  <MessageCard
    icon={<IconMapQuestion />}
    color="gray"
    title="Page not found"
    action={
      <Button component={Link} to="/" variant="default">
        Back to dashboard
      </Button>
    }
  >
    There is no page at this address.
  </MessageCard>
);
