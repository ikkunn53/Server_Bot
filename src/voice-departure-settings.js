export const VOICE_DEPARTURE_SETTINGS = {
  voice_departure_count: { label: 'VC連続退出の回数', envName: 'VOICE_DEPARTURE_COUNT', defaultValue: 2, min: 1, max: 1000, unit: '回' },
  voice_departure_window_minutes: { label: 'VC連続退出の判定時間（分）', envName: 'VOICE_DEPARTURE_WINDOW_MINUTES', defaultValue: 1, min: 1, max: 1440, unit: '分' },
  voice_departure_timeout_minutes: { label: 'VC連続退出のタイムアウト時間（分）', envName: 'VOICE_DEPARTURE_TIMEOUT_MINUTES', defaultValue: 5, min: 1, max: 40320, unit: '分' },
};

export function parseVoiceDepartureSetting(key, raw) {
  const definition = VOICE_DEPARTURE_SETTINGS[key];
  const text = String(raw ?? '').trim();
  const value = Number(text);
  return definition && /^\d+$/.test(text) && Number.isSafeInteger(value)
    && value >= definition.min && value <= definition.max ? value : null;
}

export function getVoiceDepartureDefault(key, environment = process.env) {
  const definition = VOICE_DEPARTURE_SETTINGS[key];
  // Read lazily: index.js loads dotenv after this module is imported.
  const value = parseVoiceDepartureSetting(key, environment[definition.envName]);
  return { value: value ?? definition.defaultValue, source: value == null ? '既定値' : '環境変数' };
}

export async function getVoiceDeparturePolicy(guildId, getSetting, environment = process.env) {
  const values = await Promise.all(Object.keys(VOICE_DEPARTURE_SETTINGS).map(async (key) =>
    parseVoiceDepartureSetting(key, await getSetting(guildId, key)) ?? getVoiceDepartureDefault(key, environment).value));
  return { count: values[0], windowMinutes: values[1], timeoutMinutes: values[2] };
}
