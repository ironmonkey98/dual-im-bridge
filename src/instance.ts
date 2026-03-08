import path from "node:path";

const DEFAULT_CTI_DIRNAME = ".claude-to-im";
const LAUNCHD_LABEL_PREFIX = "com.claude-to-im.bridge";

export interface InstanceOptions {
  explicitInstance?: string;
  ctiHome?: string;
  homeDir: string;
}

function sanitizeInstanceName(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return cleaned || "default";
}

export function resolveCtiHome(options: {
  explicitHome?: string;
  explicitInstance?: string;
  homeDir: string;
}): string {
  if (options.explicitHome) return options.explicitHome;
  const instance = sanitizeInstanceName(options.explicitInstance || "");
  if (!options.explicitInstance || instance === "default") {
    return path.join(options.homeDir, DEFAULT_CTI_DIRNAME);
  }
  return path.join(options.homeDir, `${DEFAULT_CTI_DIRNAME}-${instance}`);
}

export function deriveInstanceName(options: InstanceOptions): string {
  if (options.explicitInstance) {
    return sanitizeInstanceName(options.explicitInstance);
  }

  const defaultHome = path.join(options.homeDir, DEFAULT_CTI_DIRNAME);
  const resolvedHome = options.ctiHome || defaultHome;
  if (resolvedHome === defaultHome) return "default";

  const base = path.basename(resolvedHome);
  if (base === DEFAULT_CTI_DIRNAME) return "default";
  if (base.startsWith(`${DEFAULT_CTI_DIRNAME}-`)) {
    return sanitizeInstanceName(base.slice(DEFAULT_CTI_DIRNAME.length + 1));
  }
  return sanitizeInstanceName(base);
}

export function getLaunchdLabel(instanceName: string): string {
  return instanceName === "default"
    ? LAUNCHD_LABEL_PREFIX
    : `${LAUNCHD_LABEL_PREFIX}.${sanitizeInstanceName(instanceName)}`;
}
