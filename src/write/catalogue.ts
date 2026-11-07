import type { PluginHost } from '@tyto/plugin-api';

import { FRESH_MILLISECONDS } from '../cache.js';
import { record } from '../columns.js';
import type { JiraConfig } from '../config.js';
import { fingerprint } from '../cursor.js';
import { jiraError, jiraOk, messageOf, type JiraResult } from '../errors.js';
import type { JiraClient } from '../http.js';

/** One field of the site's catalogue, cut to what a write reads. */
export interface CatalogueField {
  readonly id: string;
  readonly name: string;
  readonly schema: {
    readonly type?: string;
    readonly items?: string;
    readonly custom?: string;
  };
}

/** The parts of the host the catalogue uses. */
export type CatalogueHost = Pick<PluginHost, 'cache' | 'log'>;

const FIELD_CATALOGUE = '/rest/api/3/field';

/**
 * `jira/field/v1/<site host>/<fnv(email)>`: one catalogue per site and account, since what an
 * account sees of the fields may differ. The email is hashed, so the sidecar holds no address.
 */
export function catalogueKey(config: JiraConfig): string {
  return `jira/field/v1/${new URL(config.baseUrl).host}/${fingerprint(config.email)}`;
}

/**
 * The site's field catalogue, from the plugin's cache while it is fresh (ten minutes, as the
 * page cache), else from `GET /rest/api/3/field`, which then fills the cache. **This is the
 * only request a plan may make**: a plan shows what Apply will write, and reading the issues
 * themselves is Apply's.
 *
 * As with pages, the cache never fails the plan: a host with no cache or an entry that is not
 * this plugin's shape is a warning in the log and a live read.
 */
export async function fieldCatalogue(
  host: CatalogueHost,
  client: JiraClient,
  config: JiraConfig,
  now: number,
): Promise<JiraResult<readonly CatalogueField[]>> {
  const key = catalogueKey(config);
  try {
    const stored = await host.cache.get(key);
    const age = stored === undefined ? NaN : now - Date.parse(stored.storedAt);
    const fields = stored === undefined ? undefined : entryOf(stored.bytes);
    if (stored !== undefined && fields === undefined) {
      host.log.warn('jira.set ignored a field catalogue entry it did not write');
    } else if (fields !== undefined && age >= 0 && age < FRESH_MILLISECONDS) {
      return jiraOk(fields);
    }
  } catch (thrown) {
    host.log.warn(`jira.set read no cached field catalogue: ${messageOf(thrown)}`);
  }

  const answer = await client.get(FIELD_CATALOGUE);
  if (!answer.ok) return answer;
  if (!Array.isArray(answer.value)) {
    return jiraError('E_JIRA_RESPONSE', `GET ${FIELD_CATALOGUE} answered no list of fields.`);
  }
  const fields = answer.value.flatMap((each) => fieldOf(each) ?? []);
  try {
    await host.cache.put(key, new TextEncoder().encode(JSON.stringify({ v: 1, fields })));
  } catch (thrown) {
    host.log.warn(`jira.set cached no field catalogue: ${messageOf(thrown)}`);
  }
  return jiraOk(fields);
}

function fieldOf(value: unknown): CatalogueField | undefined {
  const field = record(value);
  const id = field?.['id'];
  if (typeof id !== 'string') return undefined;
  const name = field?.['name'];
  const schema = record(field?.['schema']);
  const text = (key: string): Record<string, string> =>
    typeof schema?.[key] === 'string' ? { [key]: schema[key] } : {};
  return {
    id,
    name: typeof name === 'string' ? name : id,
    schema: { ...text('type'), ...text('items'), ...text('custom') },
  };
}

function entryOf(bytes: Uint8Array): readonly CatalogueField[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  const entry = record(parsed);
  const fields = entry?.['fields'];
  if (entry?.['v'] !== 1 || !Array.isArray(fields)) return undefined;
  const read = fields.map(fieldOf);
  return read.every((field) => field !== undefined) ? (read as CatalogueField[]) : undefined;
}
