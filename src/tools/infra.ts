import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { DatabaseClient } from "../db/client.js";
import { createLoggedTool, type RegisteredTool } from "./registry.js";
import { runCommand, runReadOnlyCommand } from "./shell.js";

export const INFRA_COMPOSE_RESTART_ACTION = "infra.compose_restart";

const stackSchema = z.object({
  stack: z.enum(["core", "iot", "observability"]).describe("Compose stack name"),
});

const systemdSchema = z.object({
  service: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_.@-]+$/)
    .describe("Allowed systemd service name configured in SYSTEMD_ALLOWED_SERVICES"),
});

const httpCheckSchema = z.object({
  url: z.string().url(),
  host: z.string().optional().describe("Optional Host header for Traefik route checks"),
});

const composeServiceRestartSchema = z.object({
  stack: z.enum(["iot"]),
  service: z.enum(["iot-hub", "iot-dashboard", "zigbee2mqtt", "mosquitto"]),
});

export type ComposeServiceRestartPayload = z.infer<typeof composeServiceRestartSchema>;

function composeFile(stack: "core" | "iot" | "observability"): string[] {
  if (stack === "core") {
    return [];
  }

  if (stack === "iot") {
    return ["-f", "compose.iot.yml"];
  }

  return ["-f", "compose.observability.yml"];
}

export function createInfraTools(
  config: AppConfig,
  db: DatabaseClient,
): Record<string, RegisteredTool> {
  return {
    infra_docker_ps: createLoggedTool({
      name: "infra_docker_ps",
      description: "Read running Docker containers on the current machine.",
      inputSchema: z.object({}),
      risk: "read",
      db,
      execute: async () => runReadOnlyCommand("docker", ["ps", "--format", "json"]),
    }),
    infra_compose_ps: createLoggedTool({
      name: "infra_compose_ps",
      description: "Read Docker Compose service status for an allowed stack.",
      inputSchema: stackSchema,
      risk: "read",
      db,
      execute: async ({ stack }) =>
        runReadOnlyCommand("docker", ["compose", ...composeFile(stack), "ps", "--format", "json"], {
          cwd: `${config.PI_INFRA_PATH}/docker`,
        }),
    }),
    infra_systemd_status: createLoggedTool({
      name: "infra_systemd_status",
      description: "Read active state for an allowed systemd service.",
      inputSchema: systemdSchema,
      risk: "read",
      db,
      execute: async ({ service }) => {
        if (!config.SYSTEMD_ALLOWED_SERVICES.includes(service)) {
          throw new Error(`Service is not allowlisted: ${service}`);
        }

        return runReadOnlyCommand("systemctl", ["is-active", service], { timeoutMs: 10_000 });
      },
    }),
    infra_http_check: createLoggedTool({
      name: "infra_http_check",
      description: "Perform a read-only HTTP HEAD/GET check with optional Host header.",
      inputSchema: httpCheckSchema,
      risk: "read",
      db,
      execute: async ({ url, host }) => {
        const args = ["-i", "--max-time", "10"];
        if (host) {
          args.push("-H", `Host: ${host}`);
        }
        args.push(url);
        return runReadOnlyCommand("curl", args, { timeoutMs: 15_000 });
      },
    }),
    infra_request_compose_restart: createLoggedTool({
      name: "infra_request_compose_restart",
      description: "Request restart for an allowlisted Docker Compose service. Creates a pending approval; the restart runs only after confirmation.",
      inputSchema: composeServiceRestartSchema,
      risk: "write",
      db,
      execute: async (payload) => requestComposeServiceRestart(db, payload),
    }),
  };
}

export async function requestComposeServiceRestart(
  db: DatabaseClient,
  payload: ComposeServiceRestartPayload,
): Promise<ComposeServiceRestartPayload & { approvalId: string; executed: false; message: string }> {
  const id = randomUUID();
  await db.createApproval({
    id,
    action: INFRA_COMPOSE_RESTART_ACTION,
    payload: JSON.stringify(payload),
  });
  console.log(`pi-agent approval created action=${INFRA_COMPOSE_RESTART_ACTION} id=${id} stack=${payload.stack} service=${payload.service}`);

  return {
    approvalId: id,
    ...payload,
    executed: false,
    message: `Нужно подтверждение. Ответь "да" или "подтверждаю", чтобы перезапустить ${payload.service}.`,
  };
}

export async function executeComposeServiceRestart(
  config: AppConfig,
  payload: ComposeServiceRestartPayload,
): Promise<{ stdout: string; stderr: string }> {
  const result = await runCommand("docker", ["compose", ...composeFile(payload.stack), "restart", payload.service], {
    cwd: `${config.PI_INFRA_PATH}/docker`,
    timeoutMs: 60_000,
  });
  console.log(`pi-agent compose restart stack=${payload.stack} service=${payload.service} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`);
  return result;
}

export function describeComposeServiceRestart(payload: ComposeServiceRestartPayload): string {
  return `Рестарт Docker Compose сервиса ${payload.service} в stack ${payload.stack}`;
}
