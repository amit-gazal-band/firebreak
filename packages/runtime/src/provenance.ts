import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform, release } from "node:os";
import { dirname, join } from "node:path";

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function packageVersion(name: string, from: string): string | null {
  try {
    const req = createRequire(join(from, "package.json"));
    let dir = dirname(req.resolve(name));
    for (let i = 0; i < 6; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === name) return pkg.version ?? null;
      } catch {
        // keep walking up
      }
      dir = dirname(dir);
    }
  } catch {
    // not installed
  }
  return null;
}

/** Code and environment provenance recorded with every match (SPEC §8.2). */
export function provenance(repoRoot: string): {
  code: Record<string, unknown>;
  environment: Record<string, unknown>;
} {
  const runtimeDir = join(repoRoot, "packages", "runtime");
  const teamsDir = join(repoRoot, "packages", "teams");
  return {
    code: {
      git_commit: git(["rev-parse", "HEAD"], repoRoot),
      git_dirty: (git(["status", "--porcelain"], repoRoot) ?? "").length > 0,
      packages: {
        "@anthropic-ai/sdk": packageVersion("@anthropic-ai/sdk", runtimeDir),
        "@anthropic-ai/claude-agent-sdk": packageVersion("@anthropic-ai/claude-agent-sdk", runtimeDir),
        "@band-ai/sdk": packageVersion("@band-ai/sdk", teamsDir),
      },
    },
    environment: {
      os: `${platform()} ${release()} ${arch()}`,
      node: process.version,
    },
  };
}
