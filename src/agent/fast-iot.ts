import type { IotDeviceCommandPayload } from "../tools/iot.js";

const DEVICE_ID_RE = /^[a-zA-Z0-9_.:-]+$/;

export function parseFastIotCommand(text: string): IotDeviceCommandPayload | undefined {
  const normalized = normalize(text);

  if (isScheduledIntent(normalized)) {
    return undefined;
  }

  const windowCommand = parseWindowCommand(normalized);
  if (windowCommand) {
    return windowCommand;
  }

  return parsePowerCommand(normalized);
}

function parsePowerCommand(normalized: string): IotDeviceCommandPayload | undefined {
  const command = hasAny(normalized, ["выключи", "выруби", "отключи", "turn off", "off"])
    ? "turn_off"
    : hasAny(normalized, ["включи", "запусти", "turn on", "on"])
      ? "turn_on"
      : undefined;
  if (!command) {
    return undefined;
  }

  const deviceId = findExplicitDeviceId(normalized);
  if (!deviceId) {
    return undefined;
  }

  return { deviceId, command };
}

function parseWindowCommand(normalized: string): IotDeviceCommandPayload | undefined {
  if (!mentionsWindow(normalized)) {
    return undefined;
  }

  const position = parsePercent(normalized);
  if (position !== undefined && hasAny(normalized, ["поставь", "установи", "открой", "set", "position"])) {
    return { deviceId: "window_opener", command: "set_position", position };
  }

  if (hasAny(normalized, ["открой", "open"])) {
    return { deviceId: "window_opener", command: "open" };
  }

  if (hasAny(normalized, ["закрой", "close"])) {
    return { deviceId: "window_opener", command: "close" };
  }

  if (hasAny(normalized, ["стоп", "останови", "stop"])) {
    return { deviceId: "window_opener", command: "stop" };
  }

  return undefined;
}

function findExplicitDeviceId(normalized: string): string | undefined {
  const match = normalized.match(/\b[a-z][a-z0-9_.:-]*_[a-z0-9_.:-]*\b/i);
  const deviceId = match?.[0];
  return deviceId && DEVICE_ID_RE.test(deviceId) ? deviceId : undefined;
}

function parsePercent(normalized: string): number | undefined {
  const match = normalized.match(/(?:на\s*)?(\d{1,3})\s*(?:%|процент|процента|процентов)?/u);
  if (!match) {
    return undefined;
  }

  const value = Number.parseInt(match[1], 10);
  return value >= 0 && value <= 100 ? value : undefined;
}

function isScheduledIntent(normalized: string): boolean {
  return hasAny(normalized, ["каждый день", "ежедневно", "каждое утро", "каждый вечер", "по расписанию"])
    || /\bв\s*\d{1,2}:\d{2}\b/.test(normalized);
}

function mentionsWindow(normalized: string): boolean {
  return /\bwindow_opener\b/.test(normalized) || /\bwindow\b/.test(normalized) || /окн|окошк/.test(normalized);
}

function hasAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
}
