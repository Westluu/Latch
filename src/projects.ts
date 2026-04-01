import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type WorkspaceKind = "root" | "worktree";

export interface StoredWorkspace {
  path: string;
  branch: string | null;
  kind: WorkspaceKind;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
}

export interface StoredProject {
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  defaultWorkspace: string;
  workspaces: Record<string, StoredWorkspace>;
}

interface LegacyStoredProject {
  path: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
}

interface ProjectsRegistryV1 {
  version: 1;
  projects: Record<string, LegacyStoredProject>;
}

interface ProjectsRegistryV2 {
  version: 2;
  projects: Record<string, StoredProject>;
}

export type ProjectsRegistry = ProjectsRegistryV2;

export interface ProjectRecord {
  alias: string;
  project: StoredProject;
}

export interface WorkspaceRecord {
  name: string;
  workspace: StoredWorkspace;
  isDefault: boolean;
}

const PROJECTS_FILE = "projects.json";
const PROJECTS_VERSION = 2 as const;
const PROJECT_ALIAS_RE = /^[A-Za-z0-9._-]+$/;
export const DEFAULT_WORKSPACE_NAME = "default";
const LATCH_WORKSPACES_DIR = ".latch/workspaces";

export const RESERVED_PROJECT_ALIASES = new Set([
  "claude",
  "open",
  "toggle",
  "chat",
  "projects",
  "project",
  "workspace",
  "workspaces",
  "tray",
  "init",
  "remove",
]);

function nowIso(): string {
  return new Date().toISOString();
}

function expandHome(inputPath: string): string {
  if (!inputPath.startsWith("~")) return inputPath;
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/")) return join(homedir(), inputPath.slice(2));
  return inputPath;
}

function resolveInputPath(inputPath: string, cwd: string = process.cwd()): string {
  const expanded = expandHome(inputPath);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function gitErrorMessage(action: string, stdout: string, stderr: string): string {
  const detail = `${stderr || stdout}`.trim().split("\n").pop()?.trim();
  return `Failed to ${action}${detail ? `: ${detail}` : "."}`;
}

function runGit(cwd: string, args: string[], action: string): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
  });

  if (result.error) {
    throw new Error(`Failed to ${action}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(gitErrorMessage(action, result.stdout, result.stderr));
  }

  return result.stdout.trim();
}

function tryRunGit(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
  });

  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function gitRepoRoot(cwd: string): string {
  return runGit(cwd, ["rev-parse", "--show-toplevel"], "locate git repository");
}

function maybeGitRepoRoot(cwd: string): string | null {
  return tryRunGit(cwd, ["rev-parse", "--show-toplevel"]);
}

function currentGitBranch(cwd: string): string | null {
  const branch = tryRunGit(cwd, ["branch", "--show-current"]);
  return branch && branch.length > 0 ? branch : null;
}

function gitBranchExists(cwd: string, branch: string): boolean {
  const result = spawnSync("git", ["-C", cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    encoding: "utf-8",
  });

  if (result.error) {
    throw new Error(`Failed to check whether branch "${branch}" exists: ${result.error.message}`);
  }

  if (result.status === 0) return true;
  if (result.status === 1) return false;

  throw new Error(gitErrorMessage(`check whether branch "${branch}" exists`, result.stdout, result.stderr));
}

function validateGitBranchName(cwd: string, branch: string): void {
  if (!branch.trim()) {
    throw new Error("Workspace branch name cannot be empty.");
  }

  runGit(cwd, ["check-ref-format", "--branch", branch], `validate branch "${branch}"`);
}

function gitPath(cwd: string, repoPath: string): string {
  const value = runGit(cwd, ["rev-parse", "--git-path", repoPath], `resolve git path "${repoPath}"`);
  return isAbsolute(value) ? value : join(cwd, value);
}

function ensureLatchWorkspaceIgnored(repoRoot: string): void {
  const excludePath = gitPath(repoRoot, "info/exclude");
  const ignoreEntry = "/.latch/";
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
  const entries = existing
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (entries.includes(ignoreEntry)) return;

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(excludePath, `${existing}${prefix}${ignoreEntry}\n`);
}

function normalizeStoredRootPath(inputPath: string): string {
  const absolute = resolveInputPath(inputPath);
  if (!existsSync(absolute)) return absolute;
  const realPath = realpathSync(absolute);
  return maybeGitRepoRoot(realPath) ?? realPath;
}

function createWorkspaceRecord(
  path: string,
  kind: WorkspaceKind,
  timestamp: string,
  branch: string | null = currentGitBranch(path)
): StoredWorkspace {
  return {
    path,
    branch,
    kind,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastOpenedAt: null,
  };
}

function createProjectRecord(rootPath: string, timestamp: string): StoredProject {
  return {
    rootPath,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastOpenedAt: null,
    defaultWorkspace: DEFAULT_WORKSPACE_NAME,
    workspaces: {
      [DEFAULT_WORKSPACE_NAME]: createWorkspaceRecord(rootPath, "root", timestamp),
    },
  };
}

function validateLegacyRegistryShape(value: unknown, configPath: string): ProjectsRegistryV1 {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid projects config at ${configPath}: expected an object.`);
  }

  const registry = value as Record<string, unknown>;
  if (registry.version !== 1) {
    throw new Error(
      `Invalid projects config at ${configPath}: unsupported version ${String(registry.version)}.`
    );
  }

  if (!registry.projects || typeof registry.projects !== "object" || Array.isArray(registry.projects)) {
    throw new Error(`Invalid projects config at ${configPath}: expected "projects" to be an object.`);
  }

  const projects: Record<string, LegacyStoredProject> = {};
  for (const [alias, project] of Object.entries(registry.projects as Record<string, unknown>)) {
    if (!project || typeof project !== "object" || Array.isArray(project)) {
      throw new Error(`Invalid projects config at ${configPath}: project "${alias}" must be an object.`);
    }
    const entry = project as Record<string, unknown>;
    if (
      typeof entry.path !== "string" ||
      typeof entry.createdAt !== "string" ||
      typeof entry.updatedAt !== "string" ||
      !(typeof entry.lastOpenedAt === "string" || entry.lastOpenedAt === null)
    ) {
      throw new Error(
        `Invalid projects config at ${configPath}: project "${alias}" has an invalid shape.`
      );
    }
    projects[alias] = {
      path: entry.path,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      lastOpenedAt: entry.lastOpenedAt,
    };
  }

  return { version: 1, projects };
}

function validateWorkspaceShape(
  alias: string,
  workspaceName: string,
  value: unknown,
  configPath: string
): StoredWorkspace {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Invalid projects config at ${configPath}: workspace "${alias}/${workspaceName}" must be an object.`
    );
  }

  const entry = value as Record<string, unknown>;
  if (
    typeof entry.path !== "string" ||
    (entry.kind !== "root" && entry.kind !== "worktree") ||
    typeof entry.createdAt !== "string" ||
    typeof entry.updatedAt !== "string"
  ) {
    throw new Error(
      `Invalid projects config at ${configPath}: workspace "${alias}/${workspaceName}" has an invalid shape.`
    );
  }

  const workspacePath = entry.path;
  const branch =
    typeof entry.branch === "string" || entry.branch === null
      ? entry.branch
      : currentGitBranch(workspacePath);
  const lastOpenedAt =
    typeof entry.lastOpenedAt === "string" || entry.lastOpenedAt === null
      ? entry.lastOpenedAt
      : null;

  return {
    path: workspacePath,
    branch,
    kind: entry.kind,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastOpenedAt,
  };
}

function validateRegistryShape(value: unknown, configPath: string): ProjectsRegistry {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid projects config at ${configPath}: expected an object.`);
  }

  const registry = value as Record<string, unknown>;
  if (registry.version !== PROJECTS_VERSION) {
    throw new Error(
      `Invalid projects config at ${configPath}: unsupported version ${String(registry.version)}.`
    );
  }

  if (!registry.projects || typeof registry.projects !== "object" || Array.isArray(registry.projects)) {
    throw new Error(`Invalid projects config at ${configPath}: expected "projects" to be an object.`);
  }

  const projects: Record<string, StoredProject> = {};
  for (const [alias, project] of Object.entries(registry.projects as Record<string, unknown>)) {
    if (!project || typeof project !== "object" || Array.isArray(project)) {
      throw new Error(`Invalid projects config at ${configPath}: project "${alias}" must be an object.`);
    }

    const entry = project as Record<string, unknown>;
    if (
      typeof entry.rootPath !== "string" ||
      typeof entry.createdAt !== "string" ||
      typeof entry.updatedAt !== "string" ||
      !(typeof entry.lastOpenedAt === "string" || entry.lastOpenedAt === null) ||
      typeof entry.defaultWorkspace !== "string" ||
      !entry.workspaces ||
      typeof entry.workspaces !== "object" ||
      Array.isArray(entry.workspaces)
    ) {
      throw new Error(
        `Invalid projects config at ${configPath}: project "${alias}" has an invalid shape.`
      );
    }

    const workspaces: Record<string, StoredWorkspace> = {};
    for (const [workspaceName, workspace] of Object.entries(entry.workspaces as Record<string, unknown>)) {
      workspaces[workspaceName] = validateWorkspaceShape(alias, workspaceName, workspace, configPath);
    }

    if (!workspaces[entry.defaultWorkspace]) {
      throw new Error(
        `Invalid projects config at ${configPath}: project "${alias}" is missing default workspace "${entry.defaultWorkspace}".`
      );
    }

    projects[alias] = {
      rootPath: entry.rootPath,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      lastOpenedAt: entry.lastOpenedAt,
      defaultWorkspace: entry.defaultWorkspace,
      workspaces,
    };
  }

  return {
    version: PROJECTS_VERSION,
    projects,
  };
}

function migrateRegistry(value: unknown, configPath: string): ProjectsRegistry {
  const legacy = validateLegacyRegistryShape(value, configPath);
  const projects: Record<string, StoredProject> = {};

  for (const [alias, project] of Object.entries(legacy.projects)) {
    const rootPath = normalizeStoredRootPath(project.path);
    const rootWorkspace: StoredWorkspace = {
      path: rootPath,
      branch: currentGitBranch(rootPath),
      kind: "root",
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      lastOpenedAt: project.lastOpenedAt,
    };

    projects[alias] = {
      rootPath,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      lastOpenedAt: project.lastOpenedAt,
      defaultWorkspace: DEFAULT_WORKSPACE_NAME,
      workspaces: {
        [DEFAULT_WORKSPACE_NAME]: rootWorkspace,
      },
    };
  }

  const migrated: ProjectsRegistry = {
    version: PROJECTS_VERSION,
    projects,
  };

  writeProjectsRegistry(migrated, configPath);
  return migrated;
}

export function getProjectsConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const baseDir = env.XDG_CONFIG_HOME
    ? resolve(env.XDG_CONFIG_HOME)
    : join(homedir(), ".config");
  return join(baseDir, "latch", PROJECTS_FILE);
}

export function readProjectsRegistry(configPath: string = getProjectsConfigPath()): ProjectsRegistry {
  if (!existsSync(configPath)) {
    return {
      version: PROJECTS_VERSION,
      projects: {},
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (error: unknown) {
    throw new Error(
      `Failed to read projects config at ${configPath}: ${(error as Error).message}`
    );
  }

  const version = (parsed as Record<string, unknown>)?.version;
  if (version === 1) {
    return migrateRegistry(parsed, configPath);
  }

  return validateRegistryShape(parsed, configPath);
}

function writeProjectsRegistry(
  registry: ProjectsRegistry,
  configPath: string = getProjectsConfigPath()
): void {
  const configDir = dirname(configPath);
  mkdirSync(configDir, { recursive: true });

  const tempPath = join(
    configDir,
    `${PROJECTS_FILE}.${process.pid}.${Date.now()}.tmp`
  );

  try {
    writeFileSync(tempPath, JSON.stringify(registry, null, 2) + "\n");
    renameSync(tempPath, configPath);
  } finally {
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {}
    }
  }
}

export function validateProjectAlias(alias: string): void {
  if (!alias) {
    throw new Error("Project alias cannot be empty.");
  }
  if (!PROJECT_ALIAS_RE.test(alias)) {
    throw new Error(
      'Project alias may only contain letters, numbers, ".", "_" and "-".'
    );
  }
  if (RESERVED_PROJECT_ALIASES.has(alias)) {
    throw new Error(`Project alias "${alias}" is reserved.`);
  }
}

export function validateWorkspaceName(workspaceName: string): void {
  if (!workspaceName) {
    throw new Error("Workspace name cannot be empty.");
  }
  if (!PROJECT_ALIAS_RE.test(workspaceName)) {
    throw new Error(
      'Workspace name may only contain letters, numbers, ".", "_" and "-".'
    );
  }
}

export function normalizeProjectPath(inputPath: string, cwd: string = process.cwd()): string {
  const absolute = resolveInputPath(inputPath, cwd);

  if (!existsSync(absolute)) {
    throw new Error(`Project path does not exist: ${absolute}`);
  }

  const stats = statSync(absolute);
  if (!stats.isDirectory()) {
    throw new Error(`Project path is not a directory: ${absolute}`);
  }

  const realPath = realpathSync(absolute);
  return maybeGitRepoRoot(realPath) ?? realPath;
}

function normalizeWorkspacePath(inputPath: string, cwd: string = process.cwd()): string {
  const absolute = resolveInputPath(inputPath, cwd);

  if (!existsSync(absolute)) {
    throw new Error(`Workspace path does not exist: ${absolute}`);
  }

  const stats = statSync(absolute);
  if (!stats.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${absolute}`);
  }

  return realpathSync(absolute);
}

function ensureProjectAliasAvailable(registry: ProjectsRegistry, alias: string): void {
  if (registry.projects[alias]) {
    throw new Error(`Project alias "${alias}" already exists.`);
  }
}

function ensureProjectPathAvailable(registry: ProjectsRegistry, normalizedPath: string): void {
  for (const [alias, project] of Object.entries(registry.projects)) {
    if (project.rootPath === normalizedPath) {
      throw new Error(`Project path is already saved as "${alias}".`);
    }
  }
}

function ensureWorkspacePathAvailable(registry: ProjectsRegistry, normalizedPath: string): void {
  for (const [projectAlias, project] of Object.entries(registry.projects)) {
    for (const [workspaceName, workspace] of Object.entries(project.workspaces)) {
      if (workspace.path === normalizedPath) {
        throw new Error(`Workspace path is already saved as "${projectAlias}/${workspaceName}".`);
      }
    }
  }
}

function getProjectOrThrow(
  registry: ProjectsRegistry,
  alias: string
): StoredProject {
  const project = registry.projects[alias];
  if (!project) {
    throw new Error(`Unknown project alias "${alias}".`);
  }
  return project;
}

function getWorkspaceOrThrow(
  project: StoredProject,
  projectAlias: string,
  workspaceName: string
): StoredWorkspace {
  const workspace = project.workspaces[workspaceName];
  if (!workspace) {
    throw new Error(`Unknown workspace "${projectAlias}/${workspaceName}".`);
  }
  return workspace;
}

function ensureWorkspaceNameAvailable(project: StoredProject, workspaceName: string): void {
  if (project.workspaces[workspaceName]) {
    throw new Error(`Workspace "${workspaceName}" already exists.`);
  }
}

function defaultWorktreePath(rootPath: string, workspaceName: string): string {
  return join(rootPath, LATCH_WORKSPACES_DIR, workspaceName);
}

function sortWorkspaceEntries(
  project: StoredProject
): Array<[string, StoredWorkspace]> {
  return Object.entries(project.workspaces).sort(([left], [right]) => {
    if (left === project.defaultWorkspace) return -1;
    if (right === project.defaultWorkspace) return 1;
    return left.localeCompare(right);
  });
}

export function addProject(
  alias: string,
  inputPath: string,
  options?: {
    cwd?: string;
    configPath?: string;
  }
): StoredProject {
  validateProjectAlias(alias);

  const configPath = options?.configPath ?? getProjectsConfigPath();
  const registry = readProjectsRegistry(configPath);
  const normalizedPath = normalizeProjectPath(inputPath, options?.cwd);

  ensureProjectAliasAvailable(registry, alias);
  ensureProjectPathAvailable(registry, normalizedPath);
  ensureWorkspacePathAvailable(registry, normalizedPath);

  const timestamp = nowIso();
  const project = createProjectRecord(normalizedPath, timestamp);

  registry.projects[alias] = project;
  writeProjectsRegistry(registry, configPath);
  return project;
}

export function addCurrentProject(
  alias: string,
  options?: {
    cwd?: string;
    configPath?: string;
  }
): StoredProject {
  const cwd = options?.cwd ?? process.cwd();
  return addProject(alias, cwd, { cwd, configPath: options?.configPath });
}

export function getProject(
  alias: string,
  configPath: string = getProjectsConfigPath()
): StoredProject | null {
  const registry = readProjectsRegistry(configPath);
  return registry.projects[alias] ?? null;
}

export function getDefaultWorkspace(project: StoredProject): StoredWorkspace {
  return getWorkspaceOrThrow(project, "<project>", project.defaultWorkspace);
}

export function getProjectPath(project: StoredProject): string {
  return getDefaultWorkspace(project).path;
}

export function getWorkspace(
  projectAlias: string,
  workspaceName: string,
  configPath: string = getProjectsConfigPath()
): StoredWorkspace | null {
  const project = getProject(projectAlias, configPath);
  if (!project) return null;
  return project.workspaces[workspaceName] ?? null;
}

export function listProjects(
  configPath: string = getProjectsConfigPath()
): ProjectRecord[] {
  const registry = readProjectsRegistry(configPath);
  return Object.entries(registry.projects)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([alias, project]) => ({ alias, project }));
}

export function listWorkspaces(
  projectAlias: string,
  configPath: string = getProjectsConfigPath()
): WorkspaceRecord[] {
  const project = getProject(projectAlias, configPath);
  if (!project) {
    throw new Error(`Unknown project alias "${projectAlias}".`);
  }

  return sortWorkspaceEntries(project).map(([name, workspace]) => ({
    name,
    workspace,
    isDefault: name === project.defaultWorkspace,
  }));
}

export function addWorkspace(
  projectAlias: string,
  workspaceName: string,
  inputPath: string,
  options?: {
    cwd?: string;
    configPath?: string;
    kind?: WorkspaceKind;
  }
): StoredWorkspace {
  validateWorkspaceName(workspaceName);

  const configPath = options?.configPath ?? getProjectsConfigPath();
  const registry = readProjectsRegistry(configPath);
  const project = getProjectOrThrow(registry, projectAlias);
  const normalizedPath = normalizeWorkspacePath(inputPath, options?.cwd);

  ensureWorkspaceNameAvailable(project, workspaceName);
  ensureWorkspacePathAvailable(registry, normalizedPath);

  const timestamp = nowIso();
  const kind = options?.kind ?? (normalizedPath === project.rootPath ? "root" : "worktree");
  const workspace = createWorkspaceRecord(normalizedPath, kind, timestamp);

  project.workspaces[workspaceName] = workspace;
  registry.projects[projectAlias] = project;
  writeProjectsRegistry(registry, configPath);
  return workspace;
}

export function createWorktreeWorkspace(
  projectAlias: string,
  workspaceName: string,
  options?: {
    branch?: string;
    configPath?: string;
  }
): StoredWorkspace {
  validateWorkspaceName(workspaceName);

  const configPath = options?.configPath ?? getProjectsConfigPath();
  const registry = readProjectsRegistry(configPath);
  const project = getProjectOrThrow(registry, projectAlias);
  ensureWorkspaceNameAvailable(project, workspaceName);

  const repoRoot = gitRepoRoot(project.rootPath);
  const branch = options?.branch ?? workspaceName;
  validateGitBranchName(repoRoot, branch);

  const worktreePath = defaultWorktreePath(project.rootPath, workspaceName);
  if (existsSync(worktreePath)) {
    throw new Error(`Workspace path already exists: ${worktreePath}`);
  }

  ensureWorkspacePathAvailable(registry, worktreePath);
  ensureLatchWorkspaceIgnored(repoRoot);
  mkdirSync(dirname(worktreePath), { recursive: true });

  const worktreeArgs = gitBranchExists(repoRoot, branch)
    ? ["worktree", "add", worktreePath, branch]
    : ["worktree", "add", "-b", branch, worktreePath];

  runGit(repoRoot, worktreeArgs, `create workspace "${projectAlias}/${workspaceName}"`);

  try {
    const normalizedPath = realpathSync(worktreePath);
    const timestamp = nowIso();
    const workspace = createWorkspaceRecord(normalizedPath, "worktree", timestamp, branch);
    project.workspaces[workspaceName] = workspace;
    registry.projects[projectAlias] = project;
    writeProjectsRegistry(registry, configPath);
    return workspace;
  } catch (error: unknown) {
    try {
      runGit(repoRoot, ["worktree", "remove", worktreePath], `remove workspace "${projectAlias}/${workspaceName}"`);
    } catch {}
    throw error;
  }
}

export function removeProject(
  alias: string,
  configPath: string = getProjectsConfigPath()
): StoredProject {
  const registry = readProjectsRegistry(configPath);
  const existing = registry.projects[alias];
  if (!existing) {
    throw new Error(`Unknown project alias "${alias}".`);
  }

  delete registry.projects[alias];
  writeProjectsRegistry(registry, configPath);
  return existing;
}

export function removeWorkspace(
  projectAlias: string,
  workspaceName: string,
  options?: {
    configPath?: string;
  }
): StoredWorkspace {
  const configPath = options?.configPath ?? getProjectsConfigPath();
  const registry = readProjectsRegistry(configPath);
  const project = getProjectOrThrow(registry, projectAlias);
  const workspace = getWorkspaceOrThrow(project, projectAlias, workspaceName);

  if (workspaceName === project.defaultWorkspace || workspace.kind === "root") {
    throw new Error(`Cannot remove the default workspace for "${projectAlias}". Remove the project instead.`);
  }

  if (workspace.kind === "worktree") {
    runGit(project.rootPath, ["worktree", "remove", workspace.path], `remove workspace "${projectAlias}/${workspaceName}"`);
  }

  delete project.workspaces[workspaceName];
  registry.projects[projectAlias] = project;
  writeProjectsRegistry(registry, configPath);
  return workspace;
}

export function markWorkspaceOpened(
  projectAlias: string,
  workspaceName: string,
  configPath: string = getProjectsConfigPath()
): StoredWorkspace {
  const registry = readProjectsRegistry(configPath);
  const project = getProjectOrThrow(registry, projectAlias);
  const existing = getWorkspaceOrThrow(project, projectAlias, workspaceName);
  const timestamp = nowIso();

  project.lastOpenedAt = timestamp;
  project.workspaces[workspaceName] = {
    ...existing,
    lastOpenedAt: timestamp,
  };

  registry.projects[projectAlias] = project;
  writeProjectsRegistry(registry, configPath);
  return project.workspaces[workspaceName];
}

export function markProjectOpened(
  alias: string,
  configPath: string = getProjectsConfigPath()
): StoredProject {
  const registry = readProjectsRegistry(configPath);
  const project = getProjectOrThrow(registry, alias);
  const defaultWorkspace = getWorkspaceOrThrow(project, alias, project.defaultWorkspace);
  const timestamp = nowIso();

  project.lastOpenedAt = timestamp;
  project.workspaces[project.defaultWorkspace] = {
    ...defaultWorkspace,
    lastOpenedAt: timestamp,
  };

  registry.projects[alias] = project;
  writeProjectsRegistry(registry, configPath);
  return project;
}
