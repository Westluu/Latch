import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface StoredProject {
  path: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
}

interface ProjectsRegistry {
  version: 1;
  projects: Record<string, StoredProject>;
}

interface ProjectRecord {
  alias: string;
  project: StoredProject;
}

const PROJECTS_FILE = "projects.json";
const PROJECTS_VERSION = 1 as const;
const PROJECT_ALIAS_RE = /^[A-Za-z0-9._-]+$/;

export const RESERVED_PROJECT_ALIASES = new Set([
  "claude",
  "open",
  "toggle",
  "chat",
  "tray",
  "init",
  "remove",
  "project",
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

  return {
    version: PROJECTS_VERSION,
    projects,
  };
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

export function normalizeProjectPath(inputPath: string, cwd: string = process.cwd()): string {
  const expanded = expandHome(inputPath);
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);

  if (!existsSync(absolute)) {
    throw new Error(`Project path does not exist: ${absolute}`);
  }

  const stats = statSync(absolute);
  if (!stats.isDirectory()) {
    throw new Error(`Project path is not a directory: ${absolute}`);
  }

  return realpathSync(absolute);
}

function ensureAliasAvailable(registry: ProjectsRegistry, alias: string): void {
  if (registry.projects[alias]) {
    throw new Error(`Project alias "${alias}" already exists.`);
  }
}

function ensurePathAvailable(registry: ProjectsRegistry, normalizedPath: string): void {
  for (const [alias, project] of Object.entries(registry.projects)) {
    if (project.path === normalizedPath) {
      throw new Error(`Project path is already saved as "${alias}".`);
    }
  }
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

  ensureAliasAvailable(registry, alias);
  ensurePathAvailable(registry, normalizedPath);

  const timestamp = nowIso();
  const project: StoredProject = {
    path: normalizedPath,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastOpenedAt: null,
  };

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

export function listProjects(
  configPath: string = getProjectsConfigPath()
): ProjectRecord[] {
  const registry = readProjectsRegistry(configPath);
  return Object.entries(registry.projects)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([alias, project]) => ({ alias, project }));
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

export function markProjectOpened(
  alias: string,
  configPath: string = getProjectsConfigPath()
): StoredProject {
  const registry = readProjectsRegistry(configPath);
  const existing = registry.projects[alias];
  if (!existing) {
    throw new Error(`Unknown project alias "${alias}".`);
  }

  const timestamp = nowIso();
  const updated: StoredProject = {
    ...existing,
    updatedAt: existing.updatedAt,
    lastOpenedAt: timestamp,
  };

  registry.projects[alias] = updated;
  writeProjectsRegistry(registry, configPath);
  return updated;
}
