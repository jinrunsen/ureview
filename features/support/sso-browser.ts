import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { IdentityScenario } from "./identity-scenario.js";
import { SsoProvider } from "./sso-provider.js";
import { defaultSsoConfig } from "../../packages/server/src/auth/sso-config.js";

const portProbe = createServer();
await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const address = portProbe.address();
if (!address || typeof address === "string") throw new Error("无法分配浏览器验收端口");
const port = address.port;
await new Promise<void>((resolve) => portProbe.close(() => resolve()));
const provider = new SsoProvider();
const app = new IdentityScenario({ port, publicOrigin: `http://localhost:${port}`, webDir: fileURLToPath(new URL("../../packages/web/dist/", import.meta.url)) });
try {
  await provider.start(); provider.interactive = true;
  await app.start(); const session = await app.setup();
  const saved = await app.request("/api/service-sso", { version: 0, clientSecret: provider.clientSecret,
    configuration: { ...defaultSsoConfig, enabled: true, issuer: provider.origin, clientId: "enterprise-client", defaultTeamId: session.user!.teamId } }, { method: "PUT" });
  if (saved.status !== 200) throw new Error("企业登录验收配置失败");
  console.log(JSON.stringify({ appOrigin: `http://localhost:${port}`, providerOrigin: provider.origin, deepLink: `http://localhost:${port}/?rules=1` }));
} catch (error) { await app.stop(); await provider.stop(); throw error; }
let closing = false;
async function close() { if (closing) return; closing = true; await app.stop(); await provider.stop(); }
process.on("SIGTERM", () => { void close(); });
process.on("SIGINT", () => { void close(); });
