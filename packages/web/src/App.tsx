import { RepositoryReviewsPage, ReviewPage } from "./reviews";
import { TeamPage } from "./auth";
import { RuleCatalogPage } from "./rules";
import { DashboardPage } from "./dashboard";
import { TeamOverviewPage } from "./team-overview";
import { RepositoriesPage } from "./repositories";
import { RepositoryDetailPage } from "./repository-detail";
import { LegacySettingsRedirect, SettingsPage } from "./settings";
import { AgentSessionPage, AgentSessionsPage } from "./agent-sessions";

export function App() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session-viewer");
  if (sessionId) return <AgentSessionPage key={sessionId} sessionId={sessionId} />;
  const reviewId = params.get("review");
  const repositoryId = params.get("repository");
  if (params.get("overview") === "1") return <TeamOverviewPage />;
  if (params.get("sessions") === "1") return <AgentSessionsPage />;
  if (params.get("rules") === "1") return <RuleCatalogPage />;
  if (params.get("team") === "1") return <TeamPage />;
  if (params.get("settings") === "1") return <LegacySettingsRedirect />;
  if (params.get("account") === "1") return <SettingsPage section="account" />;
  if (params.get("team-settings") === "1") return <SettingsPage section="team" />;
  if (params.get("instance") === "1") return <SettingsPage section="instance" />;
  if (params.get("repositories") === "1") return <RepositoriesPage />;
  if (reviewId) return <ReviewPage key={reviewId} reviewId={reviewId} />;
  if (params.get("reviews") === "1") return <RepositoryReviewsPage />;
  if (repositoryId) return <RepositoryDetailPage key={repositoryId} repositoryId={repositoryId} />;
  return <DashboardPage />;
}
