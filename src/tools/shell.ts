import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runReadOnlyCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  return runCommand(command, args, options);
}

export async function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    cwd: options?.cwd,
    timeout: options?.timeoutMs ?? 20_000,
    maxBuffer: 1024 * 1024,
  });

  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}
