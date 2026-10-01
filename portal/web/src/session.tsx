import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, api, signIn, type PortalUser } from "./api";

type SessionState =
  | { status: "loading" }
  | { status: "signed-in"; user: PortalUser }
  | { status: "login-error"; reason: string }
  | { status: "error"; message: string };

const SessionContext = createContext<PortalUser | null>(null);

export function useUser(): PortalUser {
  const user = useContext(SessionContext);
  if (!user) throw new Error("useUser outside a signed-in session");
  return user;
}

/**
 * Loads the signed-in user. Without a session the browser goes straight to
 * the Keycloak login, unless the last attempt failed (then show why, rather
 * than loop).
 */
export function SessionGate(props: {
  children: ReactNode;
  loading: ReactNode;
  loginError: (reason: string) => ReactNode;
  failure: (message: string) => ReactNode;
}) {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  useEffect(() => {
    const loginError = new URLSearchParams(window.location.search).get("loginError");
    api
      .me()
      .then((user) => setState({ status: "signed-in", user }))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          if (loginError) setState({ status: "login-error", reason: loginError });
          else signIn();
          return;
        }
        setState({ status: "error", message: "The portal server could not be reached." });
      });
  }, []);

  switch (state.status) {
    case "loading":
      return props.loading;
    case "login-error":
      return props.loginError(state.reason);
    case "error":
      return props.failure(state.message);
    case "signed-in":
      return <SessionContext.Provider value={state.user}>{props.children}</SessionContext.Provider>;
  }
}
