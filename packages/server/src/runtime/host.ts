import type { ImportGenerator } from "./import-generator.js";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boot, loadProfileDirectory } from "@deepseek-ai/dsh-app-boot";
import type { ReviewRuntime } from "../reviews/types.js";
import { ReviewError } from "../reviews/types.js";
import { validateReviewModels, type ReviewModels } from "./config.js";
import type { HostBootstrap } from "./host-plugin.js";
import { profilePatches } from "./profile.js";
import type { RuleDraftGenerator } from "./rule-generator.js";

import { ServiceCredentialProvider } from "./service-credentials.js";
import type { SessionRecorder } from "./session-capture.js";

let hostActive = false;

export async function bootReviewHost(options: {
  homeDir: string;
  models?: ReviewModels;
  resolveModels?: () => Promise<ReviewModels | undefined>;
  resolveCredential?: (ref: string) => Promise<string | undefined>;
  sessionRecorder?: SessionRecorder;
  onReady: (runtime: ReviewRuntime, ruleGenerator: RuleDraftGenerator, importGenerator: ImportGenerator) => Promise<() => Promise<void>>;
}): Promise<{ dispose: () => Promise<void>; readonly activeAgentCount: number }> {
  if (options.models) validateReviewModels(options.models);
  if (hostActive) throw new ReviewError("host_already_running", "一个进程只能启动一个评审运行时");
  hostActive = true;
  const previousHome = process.env["DSH_HOME"];
  const previousTelemetry = process.env["DSH_TELEMETRY_DISABLED"];
  const homeDir = resolve(options.homeDir);
  process.env["DSH_HOME"] = homeDir;
  process.env["DSH_TELEMETRY_DISABLED"] = "1";
  const restore = () => {
    if (previousHome === undefined) delete process.env["DSH_HOME"];
    else process.env["DSH_HOME"] = previousHome;
    if (previousTelemetry === undefined) delete process.env["DSH_TELEMETRY_DISABLED"];
    else process.env["DSH_TELEMETRY_DISABLED"] = previousTelemetry;
    hostActive = false;
  };
  try {
    const profileDir = resolve(homeDir, "profiles/ureview");
    await mkdir(profileDir, { recursive: true });
    await writeFile(resolve(profileDir, "package.json"), JSON.stringify({
      name: "ureview-runtime-profile", version: "0.0.0", private: true,
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
    }));
    await writeFile(resolve(profileDir, "cordis.patch.yml"), JSON.stringify(profilePatches(homeDir, options.models)));
    const configPath = resolve(profileDir, "cordis.yml");
    await writeFile(configPath, "[]\n");
    const profile = loadProfileDirectory("ureview", profileDir, fileURLToPath(new URL("../../package.json", import.meta.url)));
    if (profile.layers.length !== 1) throw new ReviewError("runtime_unavailable", "评审运行时未安装完整");
    const bootstrap: HostBootstrap = { models: options.models, ...(options.resolveModels ? { resolveModels: options.resolveModels } : {}),
      ...(options.sessionRecorder ? { sessionRecorder: options.sessionRecorder } : {}), onReady: options.onReady, started: false };
    const ctx = await boot("ureview", configPath, [
      ...profile.layers.flatMap((layer) => layer.patches), ...profile.patches,
      ...(options.resolveCredential ? [{ id: "credentials", disabled: true }] : []),
    ], (context) => {
      if (options.resolveCredential) {
        const resolveKey = options.resolveCredential;
        context.plugin({ name: "ureview-credentials", apply(ctx) { new ServiceCredentialProvider(ctx, { dshHome: homeDir, resolveKey }); } });
      }
      context.provide("ureviewBootstrap", bootstrap);
    }, import.meta.url);
    if (!bootstrap.started) {
      await ctx.fiber.dispose();
      throw new ReviewError("runtime_unavailable", "评审服务插件启动失败");
    }
    let disposal: Promise<void> | undefined;
    return {
      get activeAgentCount() { return ctx.agents.list().length; },
      dispose: () => disposal ??= ctx.fiber.dispose().finally(restore),
    };
  } catch {
    restore();
    throw new ReviewError("runtime_unavailable", "评审运行时启动失败，请检查服务配置与依赖");
  }
}
