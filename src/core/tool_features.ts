const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enable', 'enabled']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'disable', 'disabled']);

export const FUNCTION_MANAGEMENT_TOOL_NAMES = [
  'list_funcs',
  'read_func',
  'write_func',
  'delete_func',
  'run_func',
] as const;

export const SCHEDULE_MANAGEMENT_TOOL_NAMES = [
  'add_schedule',
  'list_schedules',
  'remove_schedule',
] as const;

function readBooleanEnv(name: string, defaultValue = true): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;
  return defaultValue;
}

export function areFunctionManagementToolsEnabled(): boolean {
  return readBooleanEnv('ENABLE_FUNCTION_MANAGEMENT_TOOLS', true);
}

export function areScheduleManagementToolsEnabled(): boolean {
  return readBooleanEnv('ENABLE_SCHEDULE_MANAGEMENT_TOOLS', true);
}

export function isDiscordToolEnabled(name: string): boolean {
  if ((FUNCTION_MANAGEMENT_TOOL_NAMES as readonly string[]).includes(name)) {
    return areFunctionManagementToolsEnabled();
  }
  if ((SCHEDULE_MANAGEMENT_TOOL_NAMES as readonly string[]).includes(name)) {
    return areScheduleManagementToolsEnabled();
  }
  return true;
}

export function filterEnabledTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter(tool => isDiscordToolEnabled(tool.name));
}
