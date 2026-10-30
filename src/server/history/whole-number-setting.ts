// Pure: reads a startup setting that is a whole number within a range.
export function parseWholeNumberSetting(
  env: Record<string, string | undefined>,
  setting: { name: string; unit: string; defaultValue: number; min: number; max: number },
): { ok: true; value: number } | { ok: false; error: string } {
  const { name, unit, defaultValue, min, max } = setting;
  const raw = env[name]?.trim();
  if (!raw) return { ok: true, value: defaultValue };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return { ok: false, error: `${name} must be a whole number of ${unit} from ${min} to ${max}, not "${raw}".` };
  }
  return { ok: true, value };
}
