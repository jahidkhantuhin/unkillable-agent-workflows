import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function prepareDemoEnvironment(root: string) {
  const file = join(root, '.env');
  try {
    await readFile(file);
    return { created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let template = await readFile(join(root, '.env.example'), 'utf8');
  const replacements: Record<string, string> = {
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    SUPPORT_LLM_PROVIDER: 'mock',
    TELEGRAM_ENABLED: 'false',
    WHATSAPP_ENABLED: 'false',
    CHAOS_ENABLED: 'false',
  };
  for (const [key, value] of Object.entries(replacements))
    template = template.replace(
      new RegExp(`^${key}=.*$`, 'm'),
      `${key}=${value}`,
    );
  try {
    await writeFile(file, template, { flag: 'wx', mode: 0o600 });
    return { created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      return { created: false };
    throw error;
  }
}
