import type { AppConfig } from "../config.js";
import type { DatabaseClient } from "../db/client.js";
import { runAgent } from "../llm/client.js";
import {
  describeComposeServiceRestart,
  executeComposeServiceRestart,
  INFRA_COMPOSE_RESTART_ACTION,
  requestComposeServiceRestart,
  type ComposeServiceRestartPayload,
} from "../tools/infra.js";
import { createToolRegistry } from "../tools/registry.js";
import {
  createIotApprovalGrant,
  createRecurringIotCommand,
  describeIotDeviceCommand,
  describeIotRecurringCommand,
  executeIotDeviceCommand,
  IOT_APPROVAL_GRANT_MS,
  IOT_DEVICE_COMMAND_ACTION,
  IOT_RECURRING_COMMAND_ACTION,
  requestIotDeviceCommand,
  type IotDeviceCommandRequestResult,
  type IotDeviceCommandPayload,
  type IotRecurringCommandPayload,
} from "../tools/iot.js";
import { appendApprovedMemory, MEMORY_APPEND_ACTION, MEMORY_REPLACE_ACTION, replaceApprovedMemory } from "../tools/memory.js";
import type { AgentInput } from "../inputs/types.js";
import { parseFastIotCommand } from "./fast-iot.js";
import { loadStaticContext } from "./context.js";

export async function handleAgentInput(
  config: AppConfig,
  db: DatabaseClient,
  input: AgentInput,
): Promise<string> {
  console.log(`pi-agent input source=${input.source} user=${input.userId ?? "unknown"} text=${JSON.stringify(input.text)}`);
  await db.insertMessage({
    source: input.source,
    userId: input.userId,
    chatId: input.chatId,
    role: "user",
    content: input.text,
  });

  const helpAnswer = buildHelpAnswer(input.text);
  if (helpAnswer) {
    await db.insertMessage({
      source: input.source,
      userId: input.userId,
      chatId: input.chatId,
      role: "assistant",
      content: helpAnswer,
    });

    return helpAnswer;
  }

  const approvalAnswer = await handlePendingApproval(config, db, input);
  if (approvalAnswer) {
    await db.insertMessage({
      source: input.source,
      userId: input.userId,
      chatId: input.chatId,
      role: "assistant",
      content: approvalAnswer,
    });

    return approvalAnswer;
  }

  const deterministicIotCommand = parseFastIotCommand(input.text);
  if (deterministicIotCommand) {
    const answer = await handleDeterministicIotCommand(config, db, deterministicIotCommand);
    await db.insertMessage({
      source: input.source,
      userId: input.userId,
      chatId: input.chatId,
      role: "assistant",
      content: answer,
    });

    return answer;
  }

  const deterministicComposeRestart = parseDeterministicComposeRestart(input.text);
  if (deterministicComposeRestart) {
    const answer = await handleDeterministicComposeRestart(db, deterministicComposeRestart);
    await db.insertMessage({
      source: input.source,
      userId: input.userId,
      chatId: input.chatId,
      role: "assistant",
      content: answer,
    });

    return answer;
  }

  const tools = createToolRegistry(config, db);
  const staticContext = await loadStaticContext(config);
  const recentMessages = await db.listRecentMessages({
    source: input.source,
    userId: input.userId,
    chatId: input.chatId,
    limit: 10,
  });
  const answer = await runAgent(config, input, staticContext, recentMessages, tools);

  await db.insertMessage({
    source: input.source,
    userId: input.userId,
    chatId: input.chatId,
    role: "assistant",
    content: answer,
  });

  return answer;
}

async function handleDeterministicIotCommand(
  config: AppConfig,
  db: DatabaseClient,
  payload: IotDeviceCommandPayload,
): Promise<string> {
  const startedAt = Date.now();
  try {
    const result = await requestIotDeviceCommand(config, db, payload);
    await db.insertToolCall({
      toolName: "deterministic_iot_window_command",
      risk: "write",
      input: JSON.stringify(payload),
      output: JSON.stringify(result),
      ok: true,
      durationMs: Date.now() - startedAt,
    });

    return formatIotRequestResult(result);
  } catch (error) {
    await db.insertToolCall({
      toolName: "deterministic_iot_window_command",
      risk: "write",
      input: JSON.stringify(payload),
      output: error instanceof Error ? error.message : String(error),
      ok: false,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

function formatIotRequestResult(result: IotDeviceCommandRequestResult): string {
  const description = describeIotDeviceCommand(result);

  if (!result.executed) {
    return `Для выполнения нужно подтверждение: ${description}. Ответь "да" или "подтверждаю".`;
  }

  if (result.statusCode !== undefined && result.statusCode >= 200 && result.statusCode < 300) {
    return `${description} отправлена. iot-hub ответил HTTP ${result.statusCode}.`;
  }

  return `Не смог выполнить: ${description}. iot-hub ответил HTTP ${result.statusCode ?? "unknown"}: ${result.body ?? ""}`.trim();
}

async function handleDeterministicComposeRestart(
  db: DatabaseClient,
  payload: ComposeServiceRestartPayload,
): Promise<string> {
  const startedAt = Date.now();
  const result = await requestComposeServiceRestart(db, payload);
  await db.insertToolCall({
    toolName: "deterministic_compose_restart_request",
    risk: "write",
    input: JSON.stringify(payload),
    output: JSON.stringify(result),
    ok: true,
    durationMs: Date.now() - startedAt,
  });

  return `Для выполнения нужно подтверждение: ${describeComposeServiceRestart(payload)}. Ответь "да" или "подтверждаю".`;
}

async function handlePendingApproval(
  config: AppConfig,
  db: DatabaseClient,
  input: AgentInput,
): Promise<string | undefined> {
  const decision = parseApprovalDecision(input.text);
  if (!decision) {
    return undefined;
  }

  const pending = (await db.listPendingApprovals()).find((approval) =>
    approval.action === IOT_DEVICE_COMMAND_ACTION ||
    approval.action === IOT_RECURRING_COMMAND_ACTION ||
    approval.action === INFRA_COMPOSE_RESTART_ACTION ||
    approval.action === MEMORY_APPEND_ACTION ||
    approval.action === MEMORY_REPLACE_ACTION,
  );
  if (!pending) {
    return undefined;
  }

  if (pending.action === MEMORY_APPEND_ACTION || pending.action === MEMORY_REPLACE_ACTION) {
    return handleMemoryApproval(config, db, pending, decision);
  }

  if (pending.action === IOT_RECURRING_COMMAND_ACTION) {
    return handleRecurringCommandApproval(config, db, pending, decision);
  }

  if (pending.action === INFRA_COMPOSE_RESTART_ACTION) {
    return handleComposeRestartApproval(config, db, pending, decision);
  }

  const payload = JSON.parse(pending.payload) as IotDeviceCommandPayload;
  const description = describeIotDeviceCommand(payload);

  if (decision === "reject") {
    await db.updateApprovalState({ id: pending.id, state: "rejected" });
    return `Ок, не выполняю: ${description}.`;
  }

  const result = await executeIotDeviceCommand(config, payload);
  await db.updateApprovalState({ id: pending.id, state: result.statusCode >= 200 && result.statusCode < 300 ? "approved" : "expired" });
  console.log(`pi-agent approval resolved action=${pending.action} id=${pending.id} decision=${decision} status=${result.statusCode}`);

  if (result.statusCode >= 200 && result.statusCode < 300) {
    await createIotApprovalGrant(db);
    return `${description} отправлена. iot-hub ответил HTTP ${result.statusCode}. Следующие IoT команды можно выполнить без повторного подтверждения в течение ${Math.round(IOT_APPROVAL_GRANT_MS / 1000)} секунд.`;
  }

  return `Не смог выполнить: ${description}. iot-hub ответил HTTP ${result.statusCode}: ${result.body}`;
}

async function handleRecurringCommandApproval(
  config: AppConfig,
  db: DatabaseClient,
  pending: { id: string; payload: string },
  decision: "approve" | "reject",
): Promise<string> {
  const payload = JSON.parse(pending.payload) as IotRecurringCommandPayload;
  const description = describeIotRecurringCommand(payload);

  if (decision === "reject") {
    await db.updateApprovalState({ id: pending.id, state: "rejected" });
    return `Ок, не создаю: ${description}.`;
  }

  const result = await createRecurringIotCommand(config, payload);
  await db.updateApprovalState({ id: pending.id, state: result.statusCode >= 200 && result.statusCode < 300 ? "approved" : "expired" });

  if (result.statusCode >= 200 && result.statusCode < 300) {
    await createIotApprovalGrant(db);
    return `${description} создана. iot-hub ответил HTTP ${result.statusCode}. Следующие IoT команды можно выполнить без повторного подтверждения в течение ${Math.round(IOT_APPROVAL_GRANT_MS / 1000)} секунд.`;
  }

  return `Не смог создать: ${description}. iot-hub ответил HTTP ${result.statusCode}: ${result.body}`;
}

async function handleComposeRestartApproval(
  config: AppConfig,
  db: DatabaseClient,
  pending: { id: string; payload: string },
  decision: "approve" | "reject",
): Promise<string> {
  const payload = JSON.parse(pending.payload) as ComposeServiceRestartPayload;
  const description = describeComposeServiceRestart(payload);

  if (decision === "reject") {
    await db.updateApprovalState({ id: pending.id, state: "rejected" });
    return `Ок, не выполняю: ${description}.`;
  }

  const startedAt = Date.now();
  try {
    const result = await executeComposeServiceRestart(config, payload);
    await db.updateApprovalState({ id: pending.id, state: "approved" });
    await db.insertToolCall({
      toolName: "infra_compose_restart",
      risk: "write",
      input: JSON.stringify(payload),
      output: JSON.stringify(result),
      ok: true,
      durationMs: Date.now() - startedAt,
    });
    console.log(`pi-agent approval resolved action=${INFRA_COMPOSE_RESTART_ACTION} id=${pending.id} decision=${decision}`);

    return `${description} выполнен.`;
  } catch (error) {
    await db.updateApprovalState({ id: pending.id, state: "expired" });
    await db.insertToolCall({
      toolName: "infra_compose_restart",
      risk: "write",
      input: JSON.stringify(payload),
      output: error instanceof Error ? error.message : String(error),
      ok: false,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

async function handleMemoryApproval(
  config: AppConfig,
  db: DatabaseClient,
  pending: { id: string; payload: string },
  decision: "approve" | "reject",
): Promise<string> {
  const payload = JSON.parse(pending.payload) as {
    path: string;
    content?: string;
    find?: string;
    replaceWith?: string;
    reason: string;
  };

  if (decision === "reject") {
    await db.updateApprovalState({ id: pending.id, state: "rejected" });
    return `Ок, не записываю memory/${payload.path}.`;
  }

  if (payload.find !== undefined && payload.replaceWith !== undefined) {
    await replaceApprovedMemory(config, { path: payload.path, find: payload.find, replaceWith: payload.replaceWith });
    await db.updateApprovalState({ id: pending.id, state: "approved" });
    return `Обновил memory/${payload.path}.`;
  }

  if (payload.content === undefined) {
    await db.updateApprovalState({ id: pending.id, state: "expired" });
    return `Не смог применить memory/${payload.path}: approval payload неполный.`;
  }

  await appendApprovedMemory(config, { path: payload.path, content: payload.content });
  await db.updateApprovalState({ id: pending.id, state: "approved" });
  return `Записал в memory/${payload.path}.`;
}

function buildHelpAnswer(text: string): string | undefined {
  const normalized = text.trim().toLowerCase();
  const compact = normalized.replace(/[?!.]+$/g, "").trim();
  const helpIntents = [
    "что ты умеешь",
    "что умеешь",
    "помощь",
    "help",
    "/help",
    "как тобой пользоваться",
    "какие команды",
    "какие команды тебе задавать",
    "что можно спросить",
  ];

  if (!helpIntents.some((intent) => compact.includes(intent))) {
    return undefined;
  }

  return [
    "Можно писать обычным языком. Полезные форматы:",
    "- `найди в обсидиане AmneziaWG`",
    "- `прочитай Operations/Pi Agent Operations Map.md`",
    "- `покажи открытые PR в Enigmadie/pi-agent`",
    "- `проверь GitHub Actions для Enigmadie/iot-dashboard`",
    "- `покажи устройства IoT`",
    "- `выключи plug_plant` -> я попрошу подтверждение",
    "- `открой окно` или `поставь window_opener на 40%` -> я попрошу подтверждение",
    "- `открывай окно на 40% в 09:00` -> я попрошу подтверждение для recurring IoT команды",
    "- `запомни: plug_plant это розетка растения` -> я предложу запись в memory и попрошу подтверждение",
    "- `plug_plant больше не розетка растения, теперь это розетка увлажнителя` -> я должен предложить исправление старой memory-записи",
    "Write/deploy/destructive actions требуют подтверждения. Current facts из интернета без live source не выдумываю.",
  ].join("\n");
}

function parseApprovalDecision(text: string): "approve" | "reject" | undefined {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
  if (["да", "ага", "ок", "окей", "yes", "y", "confirm", "подтверждаю", "подтверди"].includes(normalized)) {
    return "approve";
  }

  if (["нет", "не", "no", "n", "cancel", "отмена", "отмени"].includes(normalized)) {
    return "reject";
  }

  return undefined;
}

function parseDeterministicComposeRestart(text: string): ComposeServiceRestartPayload | undefined {
  const compact = text.trim().toLowerCase().replace(/ё/g, "е");
  const asksRestart = /рестарт|перезапуст|restart/.test(compact);

  if (!asksRestart) {
    return undefined;
  }

  if (/iot[-_ ]?hub|айот[-_ ]?хаб/.test(compact)) {
    return { stack: "iot", service: "iot-hub" };
  }

  if (/iot[-_ ]?dashboard|дашборд/.test(compact)) {
    return { stack: "iot", service: "iot-dashboard" };
  }

  if (/zigbee2mqtt|зигби/.test(compact)) {
    return { stack: "iot", service: "zigbee2mqtt" };
  }

  if (/mosquitto|mqtt|москит/.test(compact)) {
    return { stack: "iot", service: "mosquitto" };
  }

  return undefined;
}
