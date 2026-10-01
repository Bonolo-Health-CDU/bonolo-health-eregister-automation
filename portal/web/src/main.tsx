import "@mantine/core/styles.css";
import "@mantine/charts/styles.css";
import { MantineProvider } from "@mantine/core";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { Layout } from "./components/Layout";
import { Forbidden, FullPageLoader, LoginError, NoRole, NotFound, ServerUnavailable } from "./components/Messages";
import { DashboardPage } from "./pages/DashboardPage";
import { IntegrationsPage } from "./pages/IntegrationsPage";
import { UsersPage } from "./pages/UsersPage";
import { PrescriptionDetailPage } from "./pages/PrescriptionDetailPage";
import { PrescriptionsPage } from "./pages/PrescriptionsPage";
import { canUse, type Feature } from "./roles";
import { SessionGate, useUser } from "./session";
import { theme } from "./theme";

function RequireFeature({ feature, children }: { feature: Feature; children: ReactNode }) {
  const user = useUser();
  return canUse(user.roles, feature) ? children : <Forbidden />;
}

function Root() {
  const user = useUser();
  return user.roles.length ? <Layout /> : <NoRole />;
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <Root />,
    children: [
      { index: true, element: <RequireFeature feature="dashboard"><DashboardPage /></RequireFeature> },
      { path: "prescriptions", element: <RequireFeature feature="prescriptions"><PrescriptionsPage /></RequireFeature> },
      {
        path: "prescriptions/:taskId",
        element: <RequireFeature feature="prescriptions"><PrescriptionDetailPage /></RequireFeature>,
      },
      { path: "integrations", element: <RequireFeature feature="integrations"><IntegrationsPage /></RequireFeature> },
      { path: "users", element: <RequireFeature feature="users"><UsersPage /></RequireFeature> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <SessionGate
        loading={<FullPageLoader />}
        loginError={(reason) => <LoginError reason={reason} />}
        failure={(message) => <ServerUnavailable message={message} />}
      >
        <RouterProvider router={router} />
      </SessionGate>
    </MantineProvider>
  </StrictMode>,
);
