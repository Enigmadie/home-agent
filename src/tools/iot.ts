import { randomUUID } from "node:crypto";
import http from "node:http";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { DatabaseClient } from "../db/client.js";
import { createLoggedTool, type RegisteredTool } from "./registry.js";

export const IOT_APPROVAL_GRANT_ACTION = "iot.command_grant";
export const IOT_DEVICE_COMMAND_ACTION = "iot.device_command";
export const IOT_RECURRING_COMMAND_ACTION = "iot.recurring_command";
export const IOT_APPROVAL_GRANT_MS = 60_000;

const iotCommandSchema = z.object({
  deviceId: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_.:-]+$/)
    .describe("iot-hub device id, for example window_opener"),
  command: z.enum(["turn_on", "turn_off", "open", "close", "stop", "set_position"]),
  position: z.number().int().min(0).max(100).optional(),
});

const recurringCommandSchema = z.object({
  deviceId: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_.:-]+$/)
    .describe("iot-hub device id, for example window_opener"),
  command: z.enum(["turn_on", "turn_off", "open", "close", "stop", "set_position"]),
  localTime: z
    .string()
    .regex(/^\d{2}:\d{2}(:\d{2})?$/)
    .describe("Local time in APP_TIME_ZONE, for example 09:00 or 22:00:00"),
  position: z.number().int().min(0).max(100).optional(),
});

const deviceSchema = z.object({
  deviceId: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_.:-]+$/)
    .describe("iot-hub device id, for example plug_plant"),
});

type IotHubResponse = {
  statusCode: number;
  body: string;
};

export type IotDeviceCommandRequestResult = IotDeviceCommandPayload & {
  executed: boolean;
  approvalId?: string;
  statusCode?: number;
  body?: string;
  message: string;
};

export type IotDeviceCommandPayload = z.infer<typeof iotCommandSchema>;
export type IotRecurringCommandPayload = z.infer<typeof recurringCommandSchema>;

export function createIotTools(
  config: AppConfig,
  db: DatabaseClient,
): Record<string, RegisteredTool> {
  return {
    iot_list_devices: createLoggedTool({
      name: "iot_list_devices",
      description: "Read iot-hub device list through Traefik. Device dynamic state is in values, e.g. values.position/status/battery/state.",
      inputSchema: z.object({}),
      risk: "read",
      db,
      execute: async () => requestIotHub(config, "GET", "/api/devices"),
    }),
    iot_list_recurring_commands: createLoggedTool({
      name: "iot_list_recurring_commands",
      description: "Read generic recurring commands for an IoT device, including window opener schedules.",
      inputSchema: deviceSchema,
      risk: "read",
      db,
      execute: async ({ deviceId }) =>
        requestIotHub(config, "GET", `/api/devices/${encodeURIComponent(deviceId)}/recurring-commands`),
    }),
    iot_request_turn_off_device: createLoggedTool({
      name: "iot_request_turn_off_device",
      description:
        "Turn an IoT device off if a recent IoT approval grant is active; otherwise create a pending approval.",
      inputSchema: deviceSchema,
      risk: "write",
      db,
      execute: async ({ deviceId }) => requestIotDeviceCommand(config, db, { deviceId, command: "turn_off" }),
    }),
    iot_request_turn_on_device: createLoggedTool({
      name: "iot_request_turn_on_device",
      description:
        "Turn an IoT device on if a recent IoT approval grant is active; otherwise create a pending approval.",
      inputSchema: deviceSchema,
      risk: "write",
      db,
      execute: async ({ deviceId }) => requestIotDeviceCommand(config, db, { deviceId, command: "turn_on" }),
    }),
    iot_request_window_command: createLoggedTool({
      name: "iot_request_window_command",
      description:
        "Open, close, stop, or set position for a cover/window device such as window_opener. Requires confirmation unless a recent IoT approval grant is active.",
      inputSchema: iotCommandSchema,
      risk: "write",
      db,
      execute: async (payload) => requestIotDeviceCommand(config, db, payload),
    }),
    iot_request_create_recurring_command: createLoggedTool({
      name: "iot_request_create_recurring_command",
      description:
        "Create a daily recurring IoT command, e.g. set window_opener position at 09:00 or close at 22:00. Requires confirmation unless a recent IoT approval grant is active.",
      inputSchema: recurringCommandSchema,
      risk: "write",
      db,
      execute: async (payload) => requestRecurringCommand(config, db, payload),
    }),
  };
}

export async function requestIotDeviceCommand(
  config: AppConfig,
  db: DatabaseClient,
  payload: IotDeviceCommandPayload,
): Promise<IotDeviceCommandRequestResult> {
  validateIotDeviceCommand(payload);

  if (await hasActiveIotApprovalGrant(db)) {
    const result = await executeIotDeviceCommand(config, payload);
    console.log(`pi-agent iot executed command=${payload.command} device=${payload.deviceId} status=${result.statusCode}`);
    return {
      ...payload,
      executed: true,
      statusCode: result.statusCode,
      body: result.body,
      message: `${describeIotDeviceCommand(payload)} отправлена без повторного подтверждения: действует недавнее разрешение.`,
    };
  }

  const id = randomUUID();
  await db.createApproval({
    id,
    action: IOT_DEVICE_COMMAND_ACTION,
    payload: JSON.stringify(payload),
  });
  console.log(`pi-agent approval created action=${IOT_DEVICE_COMMAND_ACTION} id=${id} command=${payload.command} device=${payload.deviceId}`);

  return {
    approvalId: id,
    ...payload,
    executed: false,
    message: `Нужно подтверждение. Ответь "да" или "подтверждаю": ${describeIotDeviceCommand(payload)}.`,
  };
}

async function requestRecurringCommand(
  config: AppConfig,
  db: DatabaseClient,
  payload: IotRecurringCommandPayload,
): Promise<unknown> {
  validateIotRecurringCommand(payload);

  if (await hasActiveIotApprovalGrant(db)) {
    const result = await createRecurringIotCommand(config, payload);
    return {
      ...payload,
      executed: true,
      statusCode: result.statusCode,
      body: result.body,
      message: `${describeIotRecurringCommand(payload)} создана без повторного подтверждения: действует недавнее разрешение.`,
    };
  }

  const id = randomUUID();
  await db.createApproval({
    id,
    action: IOT_RECURRING_COMMAND_ACTION,
    payload: JSON.stringify(payload),
  });

  return {
    approvalId: id,
    ...payload,
    executed: false,
    message: `Нужно подтверждение. Ответь "да" или "подтверждаю": ${describeIotRecurringCommand(payload)}.`,
  };
}

export async function turnOffIotDevice(config: AppConfig, deviceId: string): Promise<IotHubResponse> {
  return executeIotDeviceCommand(config, { deviceId, command: "turn_off" });
}

export async function turnOnIotDevice(config: AppConfig, deviceId: string): Promise<IotHubResponse> {
  return executeIotDeviceCommand(config, { deviceId, command: "turn_on" });
}

export async function executeIotDeviceCommand(
  config: AppConfig,
  payload: IotDeviceCommandPayload,
): Promise<IotHubResponse> {
  validateIotDeviceCommand(payload);
  const device = encodeURIComponent(payload.deviceId);

  switch (payload.command) {
    case "turn_on":
      return requestIotHub(config, "POST", `/api/devices/${device}/turn-on`);
    case "turn_off":
      return requestIotHub(config, "POST", `/api/devices/${device}/turn-off`);
    case "open":
      return requestIotHub(config, "POST", `/api/devices/${device}/open`);
    case "close":
      return requestIotHub(config, "POST", `/api/devices/${device}/close`);
    case "stop":
      return requestIotHub(config, "POST", `/api/devices/${device}/stop`);
    case "set_position":
      return requestIotHub(config, "POST", `/api/devices/${device}/position`, {
        position: payload.position,
      });
  }
}

export async function createRecurringIotCommand(
  config: AppConfig,
  payload: IotRecurringCommandPayload,
): Promise<IotHubResponse> {
  validateIotRecurringCommand(payload);
  const commandPayload = payload.command === "set_position" ? { position: payload.position } : {};

  return requestIotHub(config, "POST", `/api/devices/${encodeURIComponent(payload.deviceId)}/recurring-commands`, {
    command: payload.command,
    payload: commandPayload,
    local_time: payload.localTime,
  });
}

export async function createIotApprovalGrant(db: DatabaseClient): Promise<void> {
  await db.createApprovalRecord({
    id: randomUUID(),
    action: IOT_APPROVAL_GRANT_ACTION,
    state: "approved",
    payload: JSON.stringify({ expiresAt: new Date(Date.now() + IOT_APPROVAL_GRANT_MS).toISOString() }),
  });
}

async function hasActiveIotApprovalGrant(db: DatabaseClient): Promise<boolean> {
  const grants = await db.listApprovalsByAction({ action: IOT_APPROVAL_GRANT_ACTION, limit: 5 });
  const now = Date.now();

  return grants.some((grant) => {
    if (grant.state !== "approved") {
      return false;
    }

    try {
      const payload = JSON.parse(grant.payload) as { expiresAt?: string };
      return payload.expiresAt ? Date.parse(payload.expiresAt) > now : false;
    } catch {
      return false;
    }
  });
}

export function describeIotDeviceCommand(payload: IotDeviceCommandPayload): string {
  switch (payload.command) {
    case "turn_on":
      return `Команда на включение ${payload.deviceId}`;
    case "turn_off":
      return `Команда на выключение ${payload.deviceId}`;
    case "open":
      return `Команда открыть ${payload.deviceId}`;
    case "close":
      return `Команда закрыть ${payload.deviceId}`;
    case "stop":
      return `Команда стоп для ${payload.deviceId}`;
    case "set_position":
      return `Команда установить ${payload.deviceId} в позицию ${payload.position}%`;
  }
}

export function describeIotRecurringCommand(payload: IotRecurringCommandPayload): string {
  const position = payload.command === "set_position" ? ` на ${payload.position}%` : "";
  return `Recurring IoT команда ${payload.command}${position} для ${payload.deviceId} в ${payload.localTime}`;
}

export function validateIotDeviceCommand(payload: IotDeviceCommandPayload): void {
  if (payload.command === "set_position" && payload.position === undefined) {
    throw new Error("set_position requires position 0..100");
  }
}

export function validateIotRecurringCommand(payload: IotRecurringCommandPayload): void {
  if (payload.command === "set_position" && payload.position === undefined) {
    throw new Error("set_position recurring command requires position 0..100");
  }
}

async function requestIotHub(
  config: AppConfig,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<IotHubResponse> {
  return new Promise((resolve, reject) => {
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        hostname: config.PI_HOST,
        port: 80,
        path,
        method,
        headers: {
          Host: "iot.home",
          Accept: "application/json",
          ...(serializedBody
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(serializedBody),
              }
            : {}),
        },
        timeout: 10_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error("iot-hub request timed out"));
    });
    request.on("error", reject);
    if (serializedBody) {
      request.write(serializedBody);
    }
    request.end();
  });
}
