import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthGate } from "./auth";
import { AgentSessionProvider } from "./agent-sessions";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate><AgentSessionProvider><App /></AgentSessionProvider></AuthGate>
  </StrictMode>,
);
