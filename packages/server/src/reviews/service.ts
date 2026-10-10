import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RepositoryService } from "../repositories/service.js";
import { ReviewStore, type ReviewJob } from "./store.js";
import { DiffNotReadyError, ReviewError, type PlatformFactory, type ReviewRuntime } from "./types.js";
import { ReviewRulesLoader, type ManagedRulesReader } from "../rules/load.js";
import { createRepositoryRuleSession, prepareManagedRuleEffects } from "../rules/repository.js";
import { parseGitLabReviewUrl } from "./url.js";
import { filterReviewFiles, pruneReviewWorkspace } from "./exclusions.js";
import { logEvent, failureCategory } from "../logging.js";
import { discoverArchitectureCandidates } from "./reading-context.js";
import type { RequirementSource } from "./requirement-sources.js";
import type { ReadingDocumentJob, ReadingDocumentStore } from "./reading-document-store.js";

interface WorkerOptions {
  pollIntervalMs?: number;
  retryDelayMs?: number;
  maxDiffAttempts?: number;
  managedRules?: ManagedRulesReader;
  excludedDirectories?: (repositoryId: string) => Promise<string[]>;
  /** 同时执行的任务上限，多个团队的 worker 共用一份。 */
  slots?: JobSlots;
  /** 有解读存储且运行时支持时，每轮评审在 Generator 旁并行生成解读。 */
  documents?: ReadingDocumentStore;
}

/** 后台任务的并发名额。名额用完时 worker 不再领取新任务。 */
export class JobSlots {
  private used = 0;
  constructor(public limit: number) {}
  tryAcquire(): boolean {
    if (this.used >= this.limit) return false;
    this.used++;
    return true;
  }
  release(): void { this.used = Math.max(0, this.used - 1); }
}

export class ReviewService {
  private active: Promise<boolean> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private closing = false;
  private readonly running = new Set<Promise<unknown>>();
  private readonly slots: JobSlots;
  private readonly startedAt = new Date();

  constructor(
    readonly store: ReviewStore,
    private readonly repositories: RepositoryService,
    private readonly platforms: PlatformFactory,
    private readonly runtime: ReviewRuntime,
    private readonly worktreeDir: string,
    private readonly options: WorkerOptions = {},
  ) { this.slots = options.slots ?? new JobSlots(1); }

  async acceptEvent(repositoryId: string, eventId: string, payload: unknown): Promise<{ id: string; created: boolean } | null> {
    const repository = await this.repositories.getCredentials(repositoryId);
    const platform = this.platforms(repository);
    const event = platform.onEvent(payload);
    if (!event) return null;
    return this.store.enqueue(repositoryId, eventId, event, "automatic", async (hasHistory) => {
      if (!hasHistory && !event.previousHeadSha) return event;
      const current = await platform.getPullRequest(event.iid);
      if (current.headSha !== event.headSha) return null;
      return { ...event, title: current.title, author: current.author };
    });
  }

  async rerun(id: string, requestId: string): Promise<{ id: string; created: boolean }> {
    const previous = await this.store.get(id);
    if (!previous) throw new ReviewError("not_found", "评审不存在");
    const repository = await this.repositories.getCredentials(previous.repositoryId);
    const result = await this.store.enqueue(previous.repositoryId, `manual:${requestId}`, {
      projectId: repository.projectId, iid: previous.iid, headSha: previous.headSha,
      title: previous.title, author: previous.author,
    }, "manual", async () => {
      const current = await this.platforms(repository).getPullRequest(previous.iid);
      return { projectId: repository.projectId, iid: current.iid, headSha: current.headSha,
        title: current.title, author: current.author };
    });
    if (!result) throw new ReviewError("invalid_event", "手动重跑未产生评审");
    return result;
  }

  async startFromUrl(url: string, requestId: string): Promise<{ id: string; created: boolean }> {
    const target = parseGitLabReviewUrl(url);
    const connected = await this.repositories.findByGitLabPath(target.origin, target.repositoryPath);
    if (!connected) throw new ReviewError("repository_not_connected", "请先接入此 Merge Request 所属的 GitLab 仓库");
    const repository = await this.repositories.getCredentials(connected.id);
    const result = await this.store.enqueue(repository.id, `manual:${requestId}`, {
      projectId: repository.projectId, iid: target.iid, headSha: "", title: "", author: "",
    }, "manual", async () => {
      const current = await this.platforms(repository).getPullRequest(target.iid);
      return { projectId: repository.projectId, iid: current.iid, headSha: current.headSha,
        title: current.title, author: current.author };
    });
    if (!result) throw new ReviewError("invalid_event", "手动评审未产生评审任务");
    return result;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const poll = async () => {
      try { await this.dispatch(); }
      catch { console.error("评审队列暂时不可用，将重试读取任务"); }
      if (!this.stopped) this.timer = setTimeout(() => { void poll(); }, this.options.pollIntervalMs ?? 250);
    };
    void poll();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.closing = true;
    clearTimeout(this.timer);
    await this.active;
    await Promise.all(this.running);
  }

  /** 领取并执行一个任务，等它结束；队列空时返回 false。 */
  runOnce(): Promise<boolean> {
    if (this.active) return this.active;
    this.active = this.execute().finally(() => { this.active = undefined; });
    return this.active;
  }

  /** 在并发名额内领取任务并在后台执行，只等领取完成，不等任务结束。 */
  async dispatch(): Promise<void> {
    while (!this.closing) {
      if (!this.slots.tryAcquire()) return;
      let next: (() => Promise<unknown>) | null;
      try { next = await this.claimNext(); }
      catch (error) { this.slots.release(); throw error; }
      if (!next) { this.slots.release(); return; }
      const running: Promise<unknown> = next()
        .catch(() => { console.error("后台任务异常结束"); })
        .finally(() => { this.slots.release(); this.running.delete(running); });
      this.running.add(running);
    }
  }

  private async execute(): Promise<boolean> {
    const next = await this.claimNext();
    if (!next) return false;
    await next();
    return true;
  }

  /** 先领评审，再领重新生成的解读；返回执行它的函数，队列空时返回 null。 */
  private async claimNext(): Promise<(() => Promise<unknown>) | null> {
    const job = await this.store.claim();
    if (job) return () => this.runReview(job);
    const documents = this.options.documents;
    if (!documents || !this.runtime.writeDocument) return null;
    const document = await documents.claim(this.startedAt);
    return document ? () => this.runDocument(document) : null;
  }

  private async runReview(job: ReviewJob): Promise<boolean> {
    const started = Date.now();
    logEvent("review.started", { reviewId: job.id, repositoryId: job.repositoryId, iid: job.iid, attempt: job.attempts });
    const directory = join(this.worktreeDir, job.id);
    let documentRun: Promise<void> | undefined;
    try {
      let repository;
      try { repository = await this.repositories.getCredentials(job.repositoryId); }
      catch (error) {
        if (error instanceof ReviewError && error.code === "not_found") {
          logEvent("review.skipped", { reviewId: job.id, repositoryId: job.repositoryId, reason: "repository_deleted" });
          return true;
        }
        throw error;
      }
      const platform = this.platforms(repository);
      const pullRequest = await platform.getPullRequest(job.iid);
      if (pullRequest.headSha !== job.headSha) throw new DiffNotReadyError();
      const excludedDirectories = [...await this.options.excludedDirectories?.(job.repositoryId) ?? []];
      const changes = await platform.getDiff(pullRequest);
      const files = filterReviewFiles(changes, excludedDirectories);
      logEvent("review.diff", { reviewId: job.id, files: files.length, excludedFiles: changes.length - files.length });
      await this.store.setPullRequest(job.id, pullRequest);
      await this.store.setScope(job.id, { excludedDirectories, excludedFileCount: changes.length - files.length });
      const emptyDiffPaths = files.filter((file) => file.patch === "").map((file) => file.newPath);
      const diffNotice = emptyDiffPaths.length
        ? `代码平台返回了 ${emptyDiffPaths.length} 个文件的空 diff，评审继续执行；这些文件的变更内容无法通过 diff 核对：${emptyDiffPaths.join("、")}。`
        : null;
      await this.store.setFiles(job.id, files, diffNotice);
      if (changes.length && !files.length) {
        await this.store.skip(job.id, "全部变更文件已被排除，本轮未调用模型评审。");
        logEvent("review.skipped", { reviewId: job.id });
        return true;
      }
      const retained = new Set(files);
      const excludedPaths = [...new Set([...excludedDirectories, ...changes.filter((file) =>
        file.renamedFile && !retained.has(file)).flatMap((file) => [file.oldPath, file.newPath])])];
      await mkdir(directory, { recursive: true });
      logEvent("review.workspace.started", { reviewId: job.id });
      const cwd = await platform.cloneOrUpdate(pullRequest, directory);
      await pruneReviewWorkspace(cwd, excludedPaths);
      const { rules: managedRules, relations } = await new ReviewRulesLoader(this.options.managedRules).loadWithRelations(repository.id, files);
      const rules = await prepareManagedRuleEffects(cwd, repository, pullRequest.headSha,
        [...new Set(files.flatMap((file) => [file.oldPath, file.newPath]))], managedRules, undefined, relations);
      await this.store.setRules(job.id, rules);
      logEvent("review.workspace.ready", { reviewId: job.id });
      const context = {
        reviewId: job.id, cwd, pullRequest, files, rules, excludedDirectories: excludedPaths,
        repositoryRules: () => createRepositoryRuleSession(cwd, repository, pullRequest.headSha, undefined, rules, relations),
      };
      const sources: RequirementSource[] = [{ id: "pull_request", kind: "pull_request", title: pullRequest.title,
        description: pullRequest.description, url: pullRequest.webUrl }];
      await this.readSources(job, platform, pullRequest.headSha, sources);
      const documents = this.options.documents;
      const writeDocument = this.runtime.writeDocument?.bind(this.runtime);
      if (documents && writeDocument) {
        // 解读只讲实现，与 Generator 同时开始、互不参考；失败不影响 finding，工作副本等它结束后再清理。
        const documentId = await documents.startRunning(job.id);
        const documentStarted = Date.now();
        logEvent("reading_document.started", { documentId, reviewId: job.id });
        documentRun = (async () => {
          try {
            const output = await writeDocument({ ...context, requirementSources: sources,
              architectureCandidates: await discoverArchitectureCandidates(cwd, files, excludedPaths),
              onSubmission: (submission) => documents.recordSubmission(documentId, submission) });
            await documents.complete(documentId, output);
            logEvent("reading_document.completed", { documentId, durationMs: Date.now() - documentStarted });
          } catch (error) {
            await documents.fail(documentId, error instanceof ReviewError ? error.message : "解读未能完成，请在 Agent 会话中查看过程").catch(() => {});
            logEvent("reading_document.failed", { documentId, category: failureCategory(error),
              ...(error instanceof ReviewError ? { errorCode: error.code } : {}) });
          }
        })();
      }
      logEvent("review.agent.started", { reviewId: job.id });
      const output = await this.runtime.review({
        ...context,
        onRules: (resolvedRules) => this.store.setRules(job.id, resolvedRules),
        onFinding: (finding) => this.store.reportFinding(job.id, finding),
        onReportSubmission: (submission) => this.store.recordSubmission(job.id, submission),
      });
      try { await this.store.complete(job.id, output); }
      catch { throw new ReviewError("review_write_failed", "评审报告保存失败"); }
      logEvent("review.completed", { reviewId: job.id, durationMs: Date.now() - started });
    } catch (error) {
      if (error instanceof DiffNotReadyError && job.attempts < (this.options.maxDiffAttempts ?? 5)) {
        await this.store.retry(job.id, this.options.retryDelayMs ?? 1000);
        logEvent("review.retry", { reviewId: job.id, category: "diff_not_ready" });
      } else {
        const reason = error instanceof DiffNotReadyError
          ? "代码平台尚未准备好本次提交的 diff，评审未能完成"
          : error instanceof ReviewError ? error.message : "评审未能完成，请检查服务配置后重试";
        await this.store.fail(job.id, reason, error instanceof ReviewError ? error.code : failureCategory(error));
        logEvent("review.failed", { reviewId: job.id, category: failureCategory(error),
          ...(error instanceof ReviewError ? { errorCode: error.code, ...error.diagnostic } : {}), durationMs: Date.now() - started });
      }
    } finally {
      await documentRun;
      await rm(directory, { recursive: true, force: true });
    }
    return true;
  }

  /** 读取提交与关联 issue 作为需求来源；读取失败时保留已读到的部分，解读照常进行。 */
  private async readSources(job: ReviewJob, platform: ReturnType<PlatformFactory>, headSha: string, sources: RequirementSource[]): Promise<void> {
    try {
      const commits = await platform.getCommits(job.iid);
      sources.push(...commits.map((commit) => ({ id: `commit:${commit.sha}`, kind: "commit" as const,
        title: commit.title, description: commit.message, url: commit.webUrl })));
      const issues = await platform.getClosingIssues(job.iid);
      sources.push(...issues.map((issue) => ({ id: `issue:${issue.webUrl}`, kind: "issue" as const,
        title: issue.title, description: issue.description, url: issue.webUrl })));
      if ((await platform.getPullRequest(job.iid)).headSha !== headSha) logEvent("requirement_sources.head_changed", { reviewId: job.id });
    } catch (error) {
      logEvent("requirement_sources.failed", { reviewId: job.id, category: failureCategory(error) });
    }
    await this.store.setRequirementSources(job.id, sources);
  }

  /** 评审结束后重新生成解读：按本轮提交重新拉取工作副本，PR 已有新提交时说明原因。 */
  private async runDocument(job: ReadingDocumentJob): Promise<void> {
    const documents = this.options.documents!;
    const started = Date.now();
    logEvent("reading_document.started", { documentId: job.id, reviewId: job.reviewId });
    const directory = join(this.worktreeDir, `document-${job.id}`);
    try {
      const review = await this.store.get(job.reviewId);
      if (!review?.pullRequest) throw new ReviewError("reading_document_unavailable", "评审数据不完整，无法生成解读");
      const repository = await this.repositories.getCredentials(review.repositoryId);
      const platform = this.platforms(repository);
      await mkdir(directory, { recursive: true });
      let cwd: string;
      try { cwd = await platform.cloneOrUpdate(review.pullRequest, directory); }
      catch (error) {
        if (error instanceof ReviewError && error.code === "head_changed") {
          throw new ReviewError("head_changed", "PR 已有新的提交，无法按这一轮的代码重新生成解读；请查看最新一轮评审");
        }
        throw error;
      }
      const excluded = review.scope.excludedDirectories;
      await pruneReviewWorkspace(cwd, excluded);
      const output = await this.runtime.writeDocument!({
        reviewId: review.id, cwd, pullRequest: review.pullRequest, files: review.files, rules: review.rules, excludedDirectories: excluded,
        requirementSources: review.requirementSources,
        architectureCandidates: await discoverArchitectureCandidates(cwd, review.files, excluded),
        onSubmission: (submission) => documents.recordSubmission(job.id, submission),
      });
      await documents.complete(job.id, output);
      logEvent("reading_document.completed", { documentId: job.id, durationMs: Date.now() - started });
    } catch (error) {
      await documents.fail(job.id, error instanceof ReviewError ? error.message : "解读未能完成，请在 Agent 会话中查看过程");
      logEvent("reading_document.failed", { documentId: job.id, category: failureCategory(error),
        ...(error instanceof ReviewError ? { errorCode: error.code } : {}) });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
