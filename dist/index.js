// src/errors.ts
function jiraOk(value) {
  return { ok: true, value };
}
function jiraError(code, message, details = {}) {
  return { ok: false, error: { code, message, ...details } };
}
function describeJiraError(error) {
  return `${error.code}: ${error.message}`;
}
function hostCodeOf(thrown) {
  if (typeof thrown !== "object" || thrown === null || !("code" in thrown)) return void 0;
  const code = thrown.code;
  return typeof code === "string" ? code : void 0;
}
function messageOf(thrown) {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

// src/columns.ts
var ORIGIN = "jira";
var FIXED_COLUMNS = [
  ["key", "text"],
  ["url", "link"],
  ["project", "text"],
  ["issuetype", "text"],
  ["status", "text"],
  ["status_category", "text"],
  ["summary", "text"],
  ["parent_key", "text"],
  ["assignee", "text"],
  ["labels", "list"],
  ["created", "datetime"],
  ["updated", "datetime"],
  ["description_urls", "list"],
  ["comment_urls", "list"],
  ["parent_description_urls", "list"]
].map(([name, type]) => ({ name, type, origin: ORIGIN }));
var FIXED_FIELDS = [
  "summary",
  "project",
  "issuetype",
  "status",
  "parent",
  "assignee",
  "labels",
  "created",
  "updated",
  "description",
  "comment"
];
function rowOf(issue, context) {
  const { fields } = issue;
  const created = isoUtc(fields["created"], issue.key, "created");
  if (!created.ok) return created;
  const updated = isoUtc(fields["updated"], issue.key, "updated");
  if (!updated.ok) return updated;
  const status = record(fields["status"]);
  const values = {
    key: issue.key,
    url: `${context.baseUrl}/browse/${issue.key}`,
    project: text(record(fields["project"])?.["key"]),
    issuetype: text(record(fields["issuetype"])?.["name"]),
    status: text(status?.["name"]),
    status_category: text(record(status?.["statusCategory"])?.["name"]),
    summary: text(fields["summary"]),
    parent_key: text(record(fields["parent"])?.["key"]),
    assignee: text(record(fields["assignee"])?.["displayName"]),
    labels: Array.isArray(fields["labels"]) ? fields["labels"].filter((label) => typeof label === "string") : [],
    created: created.value,
    updated: updated.value,
    description_urls: adfUrls(fields["description"]),
    comment_urls: unique(context.commentBodies.flatMap((body) => adfUrls(body))),
    parent_description_urls: adfUrls(context.parentDescription)
  };
  return jiraOk({
    key: issue.key,
    values,
    provenance: { source: ORIGIN, id: issue.id, fetchedAt: context.fetchedAt }
  });
}
var URL_IN_TEXT = /https?:\/\/[^\s<>"'`{}|\\^[\]]+/g;
var TRAILING_PUNCTUATION = /[.,;:!?)]+$/;
var CARD_NODES = /* @__PURE__ */ new Set(["inlineCard", "blockCard", "embedCard"]);
function adfUrls(document) {
  const found = [];
  const visit = (node) => {
    const current = record(node);
    if (current === void 0) return;
    if (Array.isArray(current["marks"])) {
      for (const mark of current["marks"]) {
        const markRecord = record(mark);
        const href = record(markRecord?.["attrs"])?.["href"];
        if (markRecord?.["type"] === "link" && typeof href === "string") found.push(href);
      }
    }
    const type = current["type"];
    const url = record(current["attrs"])?.["url"];
    if (typeof type === "string" && CARD_NODES.has(type) && typeof url === "string") {
      found.push(url);
    }
    if (type === "text" && typeof current["text"] === "string") {
      for (const match of current["text"].matchAll(URL_IN_TEXT)) {
        found.push(match[0].replace(TRAILING_PUNCTUATION, ""));
      }
    }
    if (Array.isArray(current["content"])) current["content"].forEach(visit);
  };
  visit(document);
  return unique(found);
}
var JIRA_DATETIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)(Z|[+-]\d{2}:?\d{2})$/;
function isoUtc(value, key, field) {
  if (value === void 0 || value === null) return jiraOk(null);
  const match = typeof value === "string" ? JIRA_DATETIME.exec(value.trim()) : null;
  const local = match?.[1];
  const zone = match?.[2];
  if (local !== void 0 && zone !== void 0) {
    const offset = zone === "Z" || zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
    const time = Date.parse(`${local}${offset}`);
    if (!Number.isNaN(time)) return jiraOk(new Date(time).toISOString());
  }
  return jiraError(
    "E_JIRA_RESPONSE",
    `${key}'s ${field} is ${JSON.stringify(value)}, which is not a Jira date and time.`
  );
}
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function text(value) {
  return typeof value === "string" ? value : null;
}
function unique(values) {
  return [...new Set(values)];
}

// src/http.ts
var MAX_RETRIES = 3;
var MAX_RETRY_AFTER_SECONDS = 30;
var BACKOFF_MILLISECONDS = [1e3, 2e3, 4e3];
var RETRIED_STATUSES = /* @__PURE__ */ new Set([429, 503]);
var QUOTED_BODY_LIMIT = 300;
var REDACTED = "[redacted]";
var defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function createJiraClient(options) {
  const { fetch, config } = options;
  const sleep = options.sleep ?? defaultSleep;
  const authorization = `Basic ${base64(`${config.email}:${config.token}`)}`;
  const redact = (text2) => [config.token, authorization.slice("Basic ".length)].reduce(
    (redacted, secret) => secret === "" ? redacted : redacted.split(secret).join(REDACTED),
    text2
  );
  async function request(method, path, query, body) {
    const url = urlOf(config.baseUrl, path, query);
    if (!url.ok) return url;
    const label = `${method} ${path}`;
    const init = {
      method,
      headers: {
        Accept: "application/json",
        Authorization: authorization,
        ...body === void 0 ? {} : { "Content-Type": "application/json" }
      },
      ...body === void 0 ? {} : { body: JSON.stringify(body) }
    };
    for (let retry = 0; ; retry += 1) {
      let response;
      try {
        response = await fetch(url.value, init);
      } catch (thrown) {
        const hostCode = hostCodeOf(thrown);
        return jiraError(
          "E_JIRA_NETWORK",
          redact(`${label} got no answer: ${messageOf(thrown)}`),
          hostCode === void 0 ? {} : { hostCode }
        );
      }
      if (RETRIED_STATUSES.has(response.status)) {
        const wait2 = retryWait(response, retry);
        if (retry < MAX_RETRIES && wait2.milliseconds !== void 0) {
          await sleep(wait2.milliseconds);
          continue;
        }
        const why = wait2.milliseconds === void 0 ? `Jira asked to wait ${wait2.seconds} s, longer than the ${MAX_RETRY_AFTER_SECONDS} s this plugin waits` : `still so after ${MAX_RETRIES} retries`;
        return jiraError(
          "E_JIRA_HTTP",
          redact(`${label} answered ${statusOf(response)}: ${why}. Try again later.`),
          { status: response.status }
        );
      }
      return answerOf(response, label, config, redact);
    }
  }
  return {
    get: (path, query) => request("GET", path, query, void 0),
    post: (path, body) => request("POST", path, void 0, body),
    async myself() {
      const answer = await request("GET", "/rest/api/3/myself", void 0, void 0);
      if (!answer.ok) return answer;
      const account = answer.value;
      if (typeof account !== "object" || account === null) {
        return jiraError("E_JIRA_RESPONSE", "GET /rest/api/3/myself answered no account.");
      }
      if (typeof account.accountId !== "string") {
        return jiraError("E_JIRA_RESPONSE", "GET /rest/api/3/myself answered no accountId.");
      }
      return jiraOk({
        accountId: account.accountId,
        ...typeof account.displayName === "string" ? { displayName: account.displayName } : {},
        ...typeof account.emailAddress === "string" ? { emailAddress: account.emailAddress } : {}
      });
    }
  };
}
async function answerOf(response, label, config, redact) {
  const { status } = response;
  if (status >= 300 && status < 400) {
    const location = headerOf(response, "location");
    return jiraError(
      "E_JIRA_REDIRECT",
      redact(
        `${label} answered ${statusOf(response)}${location === void 0 ? "" : ` to ${location}`}. A redirect is not followed: check that the site is the Jira Cloud address itself.`
      ),
      { status }
    );
  }
  if (status === 401) {
    return jiraError(
      "E_JIRA_AUTH",
      `Jira refused the API token for ${config.email} on ${config.baseUrl} (401): the token is wrong, expired or revoked, or belongs to another email. Create a new one at https://id.atlassian.com/manage-profile/security/api-tokens and store it again.`,
      { status }
    );
  }
  if (status === 403) {
    return jiraError(
      "E_JIRA_AUTH",
      redact(
        `Jira refused ${config.email} on ${config.baseUrl} (403): the account may not do ${label}, or Jira wants a CAPTCHA after failed sign-ins (sign in on the site once). ` + await quotedBody(response)
      ).trim(),
      { status }
    );
  }
  if (status < 200 || status >= 300) {
    return jiraError(
      "E_JIRA_HTTP",
      redact(`${label} answered ${statusOf(response)}. ${await quotedBody(response)}`).trim(),
      { status }
    );
  }
  const text2 = await response.text();
  if (text2.trim() === "") return jiraOk(null);
  try {
    return jiraOk(JSON.parse(text2));
  } catch {
    return jiraError(
      "E_JIRA_RESPONSE",
      `${label} answered ${status} with a body that is not JSON.`,
      {
        status
      }
    );
  }
}
function urlOf(baseUrl, path, query) {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return jiraError("E_JIRA_CONFIG", `'${path}' is not a path on the Jira site.`);
  }
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl) {
    return jiraError("E_JIRA_CONFIG", `'${path}' is not a path on the Jira site.`);
  }
  for (const [name, value] of Object.entries(query ?? {})) {
    url.searchParams.set(name, String(value));
  }
  return jiraOk(url.href);
}
function retryWait(response, retry) {
  const header = headerOf(response, "retry-after");
  const fallback = BACKOFF_MILLISECONDS[Math.min(retry, BACKOFF_MILLISECONDS.length - 1)] ?? 1e3;
  if (header === void 0) return { milliseconds: fallback, seconds: fallback / 1e3 };
  const trimmed = header.trim();
  const seconds = /^\d+$/.test(trimmed) ? Number(trimmed) : Math.max(0, Math.ceil((Date.parse(trimmed) - Date.now()) / 1e3));
  if (Number.isNaN(seconds)) return { milliseconds: fallback, seconds: fallback / 1e3 };
  return {
    milliseconds: seconds <= MAX_RETRY_AFTER_SECONDS ? seconds * 1e3 : void 0,
    seconds
  };
}
function headerOf(response, name) {
  for (const [key, value] of Object.entries(response.headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return void 0;
}
function statusOf(response) {
  return response.statusText === "" ? String(response.status) : `${response.status} ${response.statusText}`;
}
async function quotedBody(response) {
  let text2;
  try {
    text2 = (await response.text()).trim();
  } catch {
    return "";
  }
  if (text2 === "") return "";
  let quoted = text2;
  try {
    const parsed = JSON.parse(text2);
    const messages = [
      ...Array.isArray(parsed.errorMessages) ? parsed.errorMessages.map(String) : [],
      ...typeof parsed.errors === "object" && parsed.errors !== null ? Object.entries(parsed.errors).map(([field, message]) => `${field}: ${String(message)}`) : []
    ];
    if (messages.length > 0) quoted = messages.join("; ");
  } catch {
  }
  const short = quoted.length > QUOTED_BODY_LIMIT ? `${quoted.slice(0, QUOTED_BODY_LIMIT)}\u2026` : quoted;
  return `Jira said: ${short}`;
}
var BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(text2) {
  const bytes = new TextEncoder().encode(text2);
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const triple = first << 16 | (second ?? 0) << 8 | (third ?? 0);
    encoded += BASE64_ALPHABET[triple >> 18 & 63];
    encoded += BASE64_ALPHABET[triple >> 12 & 63];
    encoded += second === void 0 ? "=" : BASE64_ALPHABET[triple >> 6 & 63];
    encoded += third === void 0 ? "=" : BASE64_ALPHABET[triple & 63];
  }
  return encoded;
}

// src/cursor.ts
var MAX_CURSOR_LENGTH = 4e3;
function encodeCursor(cursor) {
  return base64(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeCursor(text2) {
  if (text2.length > MAX_CURSOR_LENGTH) {
    return `the cursor is ${text2.length} characters long, over ${MAX_CURSOR_LENGTH}`;
  }
  const json = base64UrlText(text2);
  if (json === void 0) return "the cursor is not base64url";
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return "the cursor is not JSON";
  }
  if (!isCursor(parsed)) return "the cursor is not one this plugin writes";
  return parsed;
}
function isCursor(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record2 = value;
  const mapped = record2["m"];
  return record2["v"] === 1 && typeof record2["t"] === "string" && record2["t"] !== "" && Number.isSafeInteger(record2["n"]) && record2["n"] >= 0 && Number.isSafeInteger(record2["p"]) && record2["p"] >= 2 && typeof record2["f"] === "string" && typeof mapped === "object" && mapped !== null && !Array.isArray(mapped) && Object.values(mapped).every((type) => typeof type === "string") && Number.isSafeInteger(record2["g"]) && typeof record2["c"] === "boolean";
}
var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function base64UrlText(encoded) {
  if (encoded.length % 4 === 1) return void 0;
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const character of encoded) {
    const value = ALPHABET.indexOf(character);
    if (value < 0) return void 0;
    buffer = (buffer << 6 | value) & 65535;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push(buffer >> bits & 255);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return void 0;
  }
}
var FNV_OFFSET = 0xcbf29ce484222325n;
var FNV_PRIME = 0x100000001b3n;
var MASK_64 = 0xffffffffffffffffn;
function fingerprint(text2) {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text2)) {
    hash ^= BigInt(byte);
    hash = hash * FNV_PRIME & MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

// src/cache.ts
var FRESH_MILLISECONDS = 10 * 60 * 1e3;
var ENTRY_LIMIT_BYTES = 32 * 1024 * 1024;
var SEARCH_PATH = "/rest/api/3/search/jql";
var BULK_PATH = "/rest/api/3/issue/bulkfetch";
var COMMENT_PATH = /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/;
function cacheKey(call) {
  const host = new URL(call.baseUrl).host;
  const request = fingerprint(JSON.stringify([call.jql, call.fields, call.pageSize]));
  return `jira/pull/v1/${host}/${fingerprint(call.email)}/${request}/${call.page}`;
}
function canonicalRequest(call) {
  return JSON.stringify({
    site: call.baseUrl,
    jql: call.jql,
    fields: call.fields,
    pageSize: call.pageSize,
    token: call.token ?? null
  });
}
async function readCache(host, call, generation, now) {
  let stored;
  try {
    stored = await host.cache.get(cacheKey(call));
  } catch (thrown) {
    host.log.warn(`jira.pull read no cache: ${messageOf(thrown)}`);
    return void 0;
  }
  if (stored === void 0) return void 0;
  if (stored.bytes.byteLength > ENTRY_LIMIT_BYTES) {
    host.log.warn(`jira.pull ignored a cache entry of ${stored.bytes.byteLength} bytes`);
    return void 0;
  }
  const entry = entryOf(stored.bytes);
  if (entry === void 0) {
    host.log.warn("jira.pull ignored a cache entry it did not write");
    return void 0;
  }
  const age = now - Date.parse(stored.storedAt);
  if (!(age >= 0 && age < FRESH_MILLISECONDS)) return void 0;
  if (entry.request !== canonicalRequest(call)) return void 0;
  if (generation !== void 0 && entry.gen !== generation) return void 0;
  return { raw: entry.raw, gen: entry.gen, storedAt: stored.storedAt };
}
async function writeCache(host, call, generation, raw) {
  const entry = { v: 1, request: canonicalRequest(call), gen: generation, raw };
  const bytes = new TextEncoder().encode(JSON.stringify(entry));
  if (bytes.byteLength > ENTRY_LIMIT_BYTES) {
    host.log.warn(`jira.pull cached no page of ${bytes.byteLength} bytes, over the host's limit`);
    return;
  }
  try {
    await host.cache.put(cacheKey(call), bytes);
  } catch (thrown) {
    host.log.warn(`jira.pull cached nothing: ${messageOf(thrown)}`);
  }
}
function entryOf(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return void 0;
  }
  const entry = record(parsed);
  const raw = record(entry?.["raw"]);
  const comments = record(raw?.["comments"]);
  if (entry?.["v"] !== 1 || typeof entry["request"] !== "string" || !Number.isSafeInteger(entry["gen"]) || raw === void 0 || !("search" in raw) || comments === void 0 || !Object.values(comments).every((pages) => Array.isArray(pages))) {
    return void 0;
  }
  return parsed;
}
function recordingClient(client) {
  let search = null;
  let parents = null;
  const comments = {};
  const kept = (path, value) => {
    const comment = COMMENT_PATH.exec(path)?.[1];
    if (path === SEARCH_PATH) search = value;
    else if (path === BULK_PATH) parents = value;
    else if (comment !== void 0) (comments[comment] ??= []).push(value);
  };
  return {
    client: {
      async get(path, query) {
        const answer = await client.get(path, query);
        if (answer.ok) kept(path, answer.value);
        return answer;
      },
      async post(path, body) {
        const answer = await client.post(path, body);
        if (answer.ok) kept(path, answer.value);
        return answer;
      },
      myself: () => client.myself()
    },
    raw: () => ({ search, comments, parents })
  };
}
var NOT_RECORDED = "not in the cached page";
function replayingClient(raw) {
  const read = {};
  const missing = () => jiraError("E_JIRA_RESPONSE", NOT_RECORDED);
  const answer = (path) => {
    if (path === SEARCH_PATH) return jiraOk(raw.search);
    if (path === BULK_PATH) return raw.parents === null ? missing() : jiraOk(raw.parents);
    const key = COMMENT_PATH.exec(path)?.[1];
    if (key === void 0) return missing();
    const index = read[key] ?? 0;
    read[key] = index + 1;
    const pages = raw.comments[key];
    return pages !== void 0 && index < pages.length ? jiraOk(pages[index]) : missing();
  };
  return {
    get: async (path, _query) => answer(path),
    post: async (path) => answer(path),
    myself: async () => missing()
  };
}

// src/config.ts
var RAW_RECORD = {
  safeParse: (value) => ({ success: true, data: value })
};
var CLOUD_DOMAIN = ".atlassian.net";
var NOT_CLOUD = "Only Jira Cloud on <site>.atlassian.net is supported. Jira Data Center and Server, and a Cloud site on a custom domain, are out: the plugin may reach only *.atlassian.net.";
async function resolveJiraConfig(host, section) {
  const settings = readSettings(host);
  const sectionSite = siteInSection(section);
  if (!sectionSite.ok) return sectionSite;
  const written = sectionSite.value ?? settings.baseUrl;
  if (written === void 0) {
    return jiraError(
      "E_JIRA_CONFIG",
      "No Jira site is set. Write it as baseUrl in the jira section of .tyto/project.json, or as jira.baseUrl in settings.json, such as https://example.atlassian.net."
    );
  }
  const baseUrl = cloudOrigin(written);
  if (!baseUrl.ok) return baseUrl;
  const token = await readCredential(host, "api-token");
  if (!token.ok) return token;
  if (token.value === void 0) {
    return jiraError(
      "E_JIRA_CONFIG",
      "No Jira API token is stored. Store it as the api-token credential (TYTO_PLUGIN_JIRA_API_TOKEN on the command line, the keychain in the desktop).",
      { hostCode: "E_CREDENTIAL_MISSING" }
    );
  }
  const storedEmail = await readCredential(host, "email");
  if (!storedEmail.ok) return storedEmail;
  const email = storedEmail.value ?? settings.email;
  if (email === void 0) {
    return jiraError(
      "E_JIRA_CONFIG",
      "No email for the Jira API token. Store it as the email credential (TYTO_PLUGIN_JIRA_EMAIL on the command line), or write it as jira.email in settings.json.",
      { hostCode: "E_CREDENTIAL_MISSING" }
    );
  }
  return jiraOk({ baseUrl: baseUrl.value, email, token: token.value });
}
function cloudOrigin(written) {
  let url;
  try {
    url = new URL(written.trim());
  } catch {
    return jiraError("E_JIRA_CONFIG", `'${written}' is not a URL. ${NOT_CLOUD}`);
  }
  if (url.protocol !== "https:") {
    return jiraError("E_JIRA_CONFIG", `'${written}' is not https. ${NOT_CLOUD}`);
  }
  const site = url.hostname.slice(0, -CLOUD_DOMAIN.length);
  if (!url.hostname.endsWith(CLOUD_DOMAIN) || site.length === 0 || site.includes(".")) {
    return jiraError("E_JIRA_CONFIG", `'${url.hostname}' is not a Jira Cloud site. ${NOT_CLOUD}`);
  }
  if (url.port !== "" || url.username !== "" || url.password !== "") {
    return jiraError(
      "E_JIRA_CONFIG",
      `'${written}' carries a port or a user name; write the site alone, such as https://${url.hostname}.`
    );
  }
  if (url.pathname !== "/" && url.pathname !== "" || url.search !== "" || url.hash !== "") {
    return jiraError(
      "E_JIRA_CONFIG",
      `'${written}' carries a path; write the site alone, such as https://${url.hostname}.`
    );
  }
  return jiraOk(url.origin);
}
function readSettings(host) {
  const raw = host.config(RAW_RECORD);
  if (typeof raw !== "object" || raw === null) return {};
  const record2 = raw;
  const baseUrl = nonEmptyString(record2["baseUrl"]);
  const email = nonEmptyString(record2["email"]);
  return {
    ...baseUrl === void 0 ? {} : { baseUrl },
    ...email === void 0 ? {} : { email }
  };
}
function siteInSection(section) {
  if (section === void 0 || section === null) return jiraOk(void 0);
  if (typeof section !== "object" || Array.isArray(section)) {
    return jiraError("E_JIRA_CONFIG", "The jira section of .tyto/project.json is not an object.");
  }
  const value = section["baseUrl"];
  if (value === void 0 || value === null) return jiraOk(void 0);
  if (typeof value !== "string" || value.trim() === "") {
    return jiraError(
      "E_JIRA_CONFIG",
      "baseUrl in the jira section of .tyto/project.json is not a URL, such as https://example.atlassian.net."
    );
  }
  return jiraOk(value);
}
async function readCredential(host, key) {
  try {
    return jiraOk(nonEmptyString(await host.credentials(key)));
  } catch (thrown) {
    const hostCode = hostCodeOf(thrown);
    if (hostCode === "E_CREDENTIAL_MISSING") return jiraOk(void 0);
    return jiraError(
      "E_JIRA_CONFIG",
      `Tyto could not read the ${key} credential: ${messageOf(thrown)}`,
      hostCode === void 0 ? {} : { hostCode }
    );
  }
}
function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}

// src/diagnostics.ts
var VERB_ID = "jira.pull";
var REFRESH_VERB_ID = "jira.refresh";
function verbFailed(error, verb = VERB_ID) {
  return {
    severity: "error",
    code: "E_RECIPE_VERB",
    message: `'${verb}' failed: ${withoutFinalStop(describeJiraError(error))}.`
  };
}
function argumentsProblem(problem2, verb = VERB_ID) {
  return {
    severity: "error",
    code: "E_RECIPE_ARGUMENTS",
    message: `'${verb}' ${withoutFinalStop(problem2)}.`
  };
}
function failed(diagnostic) {
  return { ok: false, error: [diagnostic] };
}
function withoutFinalStop(text2) {
  return text2.trim().replace(/\.+$/, "");
}

// src/fields.ts
var COLUMN_NAME = /^[a-z][a-z0-9_]*$/;
var FIXED_NAMES = new Set(FIXED_COLUMNS.map((column) => column.name));
var MAPPED_TYPES = /* @__PURE__ */ new Set(["text", "number", "date", "datetime", "list"]);
var FIELD_CATALOGUE = "/rest/api/3/field";
function mappedFields(section) {
  const fields = record(section)?.["fields"];
  if (fields === void 0 || fields === null) return jiraOk([]);
  const written = record(fields);
  if (written === void 0) {
    return configError(
      'fields in the jira section of .tyto/project.json is not an object of column names and field ids, such as {"story_points": "customfield_10016"}'
    );
  }
  const mapped = [];
  for (const [column, id] of Object.entries(written)) {
    if (!COLUMN_NAME.test(column)) {
      return configError(
        `fields names a column '${column}'; a column name is lower case letters, digits and _, starting with a letter, such as story_points`
      );
    }
    if (FIXED_NAMES.has(column)) {
      return configError(
        `fields names a column '${column}', which every pull already answers; choose another name`
      );
    }
    if (typeof id !== "string" || id.trim() === "") {
      return configError(
        `fields maps ${column} to ${JSON.stringify(id)}, which is not a field id, such as customfield_10016`
      );
    }
    mapped.push({ column, id: id.trim() });
  }
  return jiraOk(mapped);
}
async function mappedTypes(client, mapped) {
  if (mapped.length === 0) return jiraOk({});
  const answer = await client.get(FIELD_CATALOGUE);
  if (!answer.ok) return answer;
  if (!Array.isArray(answer.value)) {
    return jiraError("E_JIRA_RESPONSE", `GET ${FIELD_CATALOGUE} answered no list of fields.`);
  }
  const catalogue = answer.value.map((field) => record(field)).filter((field) => !!field);
  const types = {};
  for (const { column, id } of mapped) {
    const field = catalogue.find((candidate) => candidate["id"] === id);
    if (field === void 0) return configError(unknownField(column, id, catalogue));
    types[column] = typeOfSchema(record(field["schema"])?.["type"]);
  }
  return jiraOk(types);
}
function unknownField(column, written, catalogue) {
  const lowered = written.toLowerCase();
  const named = catalogue.filter((field) => typeof field["name"] === "string" && field["name"].toLowerCase() === lowered).map((field) => field["id"]).filter((id) => typeof id === "string");
  if (named.length === 0) {
    return `fields maps ${column} to '${written}', and this site has no field with that id`;
  }
  return `fields maps ${column} to '${written}', which is a field's name, not its id; write ` + named.join(" or ");
}
function typeOfSchema(type) {
  switch (type) {
    case "number":
      return "number";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    case "array":
      return "list";
    default:
      return "text";
  }
}
function sameColumns(types, mapped) {
  const names = Object.keys(types);
  return names.length === mapped.length && mapped.every(({ column }) => MAPPED_TYPES.has(types[column] ?? "")) && names.every((name) => mapped.some(({ column }) => column === name));
}
function mappedColumns(mapped, types) {
  return mapped.map(({ column }) => ({
    name: column,
    type: types[column] ?? "text",
    origin: ORIGIN
  }));
}
function mappedValues(fields, key, mapped, types) {
  const values = {};
  for (const { column, id } of mapped) {
    const value = cellOf(types[column] ?? "text", fields[id], key, column);
    if (!value.ok) return value;
    values[column] = value.value;
  }
  return jiraOk(values);
}
var JIRA_DATE = /^\d{4}-\d{2}-\d{2}$/;
function cellOf(type, value, key, column) {
  if (type === "list") {
    if (value === void 0 || value === null) return jiraOk([]);
    return Array.isArray(value) ? jiraOk(value.map((item) => typeof item === "number" ? item : textOf(item))) : jiraOk([textOf(value)]);
  }
  if (value === void 0 || value === null) return jiraOk(null);
  switch (type) {
    case "number":
      if (typeof value === "number" && Number.isFinite(value)) return jiraOk(value);
      return notA(key, column, value, "number");
    case "date":
      if (typeof value === "string" && JIRA_DATE.test(value)) return jiraOk(value);
      return notA(key, column, value, "date, such as 2026-10-01");
    case "datetime":
      return isoUtc(value, key, column);
    case "text":
      return jiraOk(textOf(value));
  }
}
function notA(key, column, value, what) {
  return jiraError(
    "E_JIRA_RESPONSE",
    `${key}'s ${column} is ${JSON.stringify(value)}, which is not a ${what}.`
  );
}
function textOf(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const object = record(value);
  if (object?.["type"] === "doc") return documentText(object);
  for (const name of ["value", "name", "displayName"]) {
    const shown = object?.[name];
    if (typeof shown === "string") return shown;
  }
  return JSON.stringify(value) ?? "";
}
function documentText(document) {
  const inline = (node) => {
    const current = record(node);
    if (current === void 0) return "";
    if (typeof current["text"] === "string") return current["text"];
    if (current["type"] === "hardBreak") return "\n";
    return Array.isArray(current["content"]) ? current["content"].map(inline).join("") : "";
  };
  const blocks = Array.isArray(document["content"]) ? document["content"] : [];
  return blocks.map(inline).filter((line) => line !== "").join("\n");
}
function configError(message) {
  return jiraError("E_JIRA_CONFIG", `${message}.`);
}

// src/search.ts
var PAGE_SIZE = 50;
var COMMENT_PAGE_SIZE = 100;
var SEARCH_PATH2 = "/rest/api/3/search/jql";
async function jqlOf(client, selector) {
  switch (selector.kind) {
    case "jql":
      return jiraOk(selector.jql);
    case "keys":
      return jiraOk(`key in (${selector.keys.join(", ")})`);
    case "parent":
      return jiraOk(`parent = ${selector.key}`);
    case "board":
      return boardJql(client, selector.board);
  }
}
async function boardJql(client, board) {
  const configuration = await client.get(`/rest/agile/1.0/board/${board}/configuration`);
  if (!configuration.ok) return configuration;
  const filterId = record(record(configuration.value)?.["filter"])?.["id"];
  if (typeof filterId !== "string" && typeof filterId !== "number") {
    return jiraError(
      "E_JIRA_CONFIG",
      `board ${board} has no saved filter, so there is no JQL to pull it by. Pull its project with jql= instead.`
    );
  }
  const filter = await client.get(`/rest/api/3/filter/${encodeURIComponent(String(filterId))}`);
  if (!filter.ok) return filter;
  const jql = record(filter.value)?.["jql"];
  if (typeof jql !== "string" || jql.trim() === "") {
    return jiraError(
      "E_JIRA_RESPONSE",
      `filter ${String(filterId)} of board ${board} answered no JQL.`
    );
  }
  return jiraOk(jql);
}
async function searchPage(client, jql, fields, token) {
  const answer = await client.post(SEARCH_PATH2, {
    jql,
    fields,
    maxResults: PAGE_SIZE,
    ...token === void 0 ? {} : { nextPageToken: token }
  });
  if (!answer.ok) return answer;
  const body = record(answer.value);
  const issues = body?.["issues"];
  if (body === void 0 || !Array.isArray(issues)) {
    return shapeError(`POST ${SEARCH_PATH2} answered no issues list`);
  }
  const pulled = [];
  for (const issue of issues) {
    const checked = issueOf(issue);
    if (checked === void 0) {
      return shapeError(`POST ${SEARCH_PATH2} answered an issue without an id, a key or fields`);
    }
    pulled.push(checked);
  }
  const next = body["nextPageToken"];
  if (next !== void 0 && next !== null && (typeof next !== "string" || next === "")) {
    return shapeError(`POST ${SEARCH_PATH2} answered a nextPageToken that is not text`);
  }
  const nextPageToken = typeof next === "string" ? next : void 0;
  const isLast = body["isLast"];
  if (isLast !== void 0 && typeof isLast !== "boolean") {
    return shapeError(`POST ${SEARCH_PATH2} answered an isLast that is not true or false`);
  }
  return jiraOk({
    issues: pulled,
    ...nextPageToken === void 0 ? {} : { nextPageToken },
    isLast: isLast ?? nextPageToken === void 0
  });
}
async function commentBodies(client, issue) {
  const embedded = record(issue.fields["comment"]);
  const comments = Array.isArray(embedded?.["comments"]) ? embedded["comments"] : [];
  const total = embedded?.["total"];
  if (typeof total !== "number" || total <= comments.length) {
    return jiraOk(comments.map((comment) => record(comment)?.["body"]));
  }
  const path = `/rest/api/3/issue/${encodeURIComponent(issue.key)}/comment`;
  const bodies = [];
  while (bodies.length < total) {
    const page = await client.get(path, {
      orderBy: "created",
      startAt: bodies.length,
      maxResults: COMMENT_PAGE_SIZE
    });
    if (!page.ok) return page;
    const answered = record(page.value)?.["comments"];
    if (!Array.isArray(answered)) return shapeError(`GET ${path} answered no comments list`);
    if (answered.length === 0) break;
    bodies.push(...answered.map((comment) => record(comment)?.["body"]));
  }
  return jiraOk(bodies);
}
async function parentDescriptions(client, issues) {
  const onPage = new Map(issues.map((issue) => [issue.key, issue.fields["description"]]));
  const descriptions = /* @__PURE__ */ new Map();
  const missing = /* @__PURE__ */ new Set();
  for (const issue of issues) {
    const parent = record(issue.fields["parent"])?.["key"];
    if (typeof parent !== "string") continue;
    if (onPage.has(parent)) descriptions.set(parent, onPage.get(parent));
    else missing.add(parent);
  }
  if (missing.size === 0) return jiraOk(descriptions);
  const fetched = await bulkIssues(client, [...missing], ["description"]);
  if (!fetched.ok) return fetched;
  for (const issue of fetched.value.issues)
    descriptions.set(issue.key, issue.fields["description"]);
  return jiraOk(descriptions);
}
var BULK_FETCH_SIZE = 100;
var BULK_FETCH_PATH = "/rest/api/3/issue/bulkfetch";
async function bulkIssues(client, idsOrKeys, fields) {
  const issues = [];
  const refused2 = /* @__PURE__ */ new Set();
  for (let start = 0; start < idsOrKeys.length; start += BULK_FETCH_SIZE) {
    const answer = await client.post(BULK_FETCH_PATH, {
      issueIdsOrKeys: idsOrKeys.slice(start, start + BULK_FETCH_SIZE),
      fields
    });
    if (!answer.ok) return answer;
    const body = record(answer.value);
    const fetched = body?.["issues"];
    if (!Array.isArray(fetched))
      return shapeError(`POST ${BULK_FETCH_PATH} answered no issues list`);
    for (const issue of fetched) {
      const checked = issueOf(issue);
      if (checked !== void 0) issues.push(checked);
    }
    const errors = body?.["issueErrors"];
    for (const error of Array.isArray(errors) ? errors : []) {
      const named = record(error)?.["issueIdsOrKeys"];
      for (const key of Array.isArray(named) ? named : []) {
        if (typeof key === "string") refused2.add(key);
      }
    }
  }
  return jiraOk({ issues, refused: refused2 });
}
function issueOf(value) {
  const issue = record(value);
  const fields = record(issue?.["fields"]);
  const id = issue?.["id"];
  const key = issue?.["key"];
  if (typeof id !== "string" || id === "" || typeof key !== "string" || key === "") {
    return void 0;
  }
  return fields === void 0 ? void 0 : { id, key, fields };
}
function shapeError(message) {
  return jiraError("E_JIRA_RESPONSE", `${message}.`);
}

// src/rows.ts
async function readIssues(client, issues) {
  const parents = await parentDescriptions(client, issues);
  if (!parents.ok) return parents;
  const comments = [];
  for (const issue of issues) {
    const bodies = await commentBodies(client, issue);
    if (!bodies.ok) return bodies;
    comments.push(bodies.value);
  }
  return jiraOk({ parents: parents.value, comments });
}
function issueRow(issue, comments, parents, context) {
  const parentKey = record(issue.fields["parent"])?.["key"];
  const row = rowOf(issue, {
    baseUrl: context.baseUrl,
    fetchedAt: context.fetchedAt,
    commentBodies: comments,
    parentDescription: typeof parentKey === "string" ? parents.get(parentKey) : void 0
  });
  if (!row.ok) return row;
  const values = mappedValues(issue.fields, issue.key, context.mapped, context.types);
  if (!values.ok) return values;
  return jiraOk({ ...row.value, values: { ...row.value.values, ...values.value } });
}

// src/pull.ts
var DEFAULT_MAX = 1e4;
var MAX_MAX = 1e5;
var SELECTORS = ["jql", "board", "keys", "parent"];
var ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
var ARGUMENTS = [
  { name: "jql", type: "text" },
  { name: "board", type: "number" },
  { name: "keys", type: "text" },
  { name: "parent", type: "text" },
  { name: "max", type: "number" }
];
function pullVerb(host) {
  return {
    id: VERB_ID,
    kind: "source",
    arguments: ARGUMENTS,
    page: (request) => pullPage(host, request)
  };
}
async function pullPage(host, request) {
  const asked = readRequest(request.arguments);
  if ("severity" in asked) return failed(asked);
  let cursor;
  if (request.cursor !== void 0) {
    const decoded = decodeCursor(request.cursor);
    if (typeof decoded === "string") {
      return failed({
        severity: "error",
        code: "E_RECIPE_VERB",
        message: `'${VERB_ID}' failed: ${decoded}; run again.`
      });
    }
    cursor = decoded;
  }
  const config = await resolveJiraConfig(host, request.section);
  if (!config.ok) return failed(verbFailed(config.error));
  const mapped = mappedFields(request.section);
  if (!mapped.ok) return failed(verbFailed(mapped.error));
  const client = createJiraClient({
    fetch: (url, init) => host.fetch(url, init),
    config: config.value
  });
  const jql = await jqlOf(client, asked.selector);
  if (!jql.ok) return failed(verbFailed(jql.error));
  const fields = [.../* @__PURE__ */ new Set([...FIXED_FIELDS, ...mapped.value.map(({ id }) => id)])];
  const requestPrint = fingerprint(
    JSON.stringify([config.value.baseUrl, jql.value, fields, mapped.value])
  );
  const changed = verbFailed({
    code: "E_JIRA_CONFIG",
    message: "the jira section changed during the pull; run again"
  });
  if (cursor !== void 0 && cursor.f !== requestPrint) return failed(changed);
  let types;
  if (cursor === void 0) {
    const read2 = await mappedTypes(client, mapped.value);
    if (!read2.ok) return failed(verbFailed(read2.error));
    types = read2.value;
  } else {
    if (!sameColumns(cursor.m, mapped.value)) return failed(changed);
    types = cursor.m;
  }
  const call = {
    baseUrl: config.value.baseUrl,
    email: config.value.email,
    jql: jql.value,
    fields,
    pageSize: PAGE_SIZE,
    token: cursor?.t,
    page: cursor?.p ?? 1
  };
  const now = Date.now();
  let read;
  let generation = cursor?.g ?? now;
  let fetchedAt = new Date(now).toISOString();
  let fromCache = false;
  const cached = request.refresh === true ? void 0 : await readCache(host, call, cursor?.g, now);
  if (cached !== void 0) {
    const replayed = await readPage(replayingClient(cached.raw), call);
    if (replayed.ok) {
      read = replayed.value;
      generation = cached.gen;
      fetchedAt = cached.storedAt;
      fromCache = true;
    }
  }
  if (read === void 0) {
    const recorder = recordingClient(client);
    const live = await readPage(recorder.client, call);
    if (!live.ok) return failed(verbFailed(live.error));
    read = live.value;
    await writeCache(host, call, generation, recorder.raw());
  }
  const rows = [];
  for (const [index, issue] of read.page.issues.entries()) {
    const row = issueRow(issue, read.comments[index] ?? [], read.parents, {
      baseUrl: config.value.baseUrl,
      fetchedAt,
      mapped: mapped.value,
      types
    });
    if (!row.ok) return failed(verbFailed(row.error));
    rows.push(row.value);
  }
  const table = { columns: [...FIXED_COLUMNS, ...mappedColumns(mapped.value, types)], rows };
  const { isLast, nextPageToken } = read.page;
  const total = (cursor?.n ?? 0) + rows.length;
  const truncated = total > asked.max || !isLast && total === asked.max || !isLast && nextPageToken === void 0;
  if (truncated) return { ok: true, value: { table, truncated: true }, diagnostics: [] };
  if (isLast || nextPageToken === void 0) return { ok: true, value: { table }, diagnostics: [] };
  if (cursor !== void 0 && request.cursor !== void 0 && nextPageToken === cursor.t) {
    return { ok: true, value: { table, cursor: request.cursor }, diagnostics: [] };
  }
  const next = encodeCursor({
    v: 1,
    t: nextPageToken,
    n: total,
    p: (cursor?.p ?? 1) + 1,
    f: requestPrint,
    m: types,
    g: generation,
    c: fromCache
  });
  return { ok: true, value: { table, cursor: next }, diagnostics: [] };
}
async function readPage(client, call) {
  const page = await searchPage(client, call.jql, call.fields, call.token);
  if (!page.ok) return page;
  const read = await readIssues(client, page.value.issues);
  if (!read.ok) return read;
  return { ok: true, value: { page: page.value, ...read.value } };
}
function readRequest(values) {
  const given = SELECTORS.filter((name) => values[name] !== void 0);
  if (given.length === 0) {
    return argumentsProblem("needs one of jql=, board=, keys= or parent=, and was given none");
  }
  if (given.length > 1) {
    return argumentsProblem(
      `takes one of jql=, board=, keys= or parent=, and was given ${given.map((name) => `${name}=`).join(" and ")}`
    );
  }
  const max = values["max"] ?? DEFAULT_MAX;
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1 || max > MAX_MAX) {
    return argumentsProblem(`max= must be a whole number from 1 to ${MAX_MAX}, not ${String(max)}`);
  }
  const selector = selectorOf(given[0] ?? "jql", values);
  return "severity" in selector ? selector : { selector, max };
}
function selectorOf(name, values) {
  const value = values[name];
  if (name === "board") {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? { kind: "board", board: value } : argumentsProblem(`board= must be a board's number, such as board=12, not ${String(value)}`);
  }
  const written = String(value).trim();
  if (name === "jql") {
    return written === "" ? argumentsProblem('jql= is empty; write a query, such as jql="project = EX"') : { kind: "jql", jql: written };
  }
  if (name === "parent") {
    return ISSUE_KEY.test(written) ? { kind: "parent", key: written } : argumentsProblem(`parent= holds '${written}', which is not one issue key, such as EX-1`);
  }
  const keys = written.split(",").map((key) => key.trim());
  const bad = keys.find((key) => !ISSUE_KEY.test(key));
  if (bad !== void 0) {
    return argumentsProblem(
      `keys= holds '${bad}', which is not an issue key; write keys such as keys="EX-1,EX-2"`
    );
  }
  return { kind: "keys", keys: [...new Set(keys)] };
}

// src/refresh.ts
var MAX_KEYS = 1e3;
var MAX_CHILDREN = 5e3;
var BUDGET_MILLISECONDS = 25e3;
var PARENTS_PER_SEARCH = 100;
var ARGUMENTS2 = [
  { name: "by", type: "text" },
  { name: "only", type: "text" },
  { name: "children", type: "boolean" }
];
var systemClock = { now: () => Date.now() };
function refreshVerb(host, clock = systemClock) {
  return {
    id: REFRESH_VERB_ID,
    kind: "transform",
    arguments: ARGUMENTS2,
    transform: (request) => refreshTable(host, request, clock)
  };
}
async function refreshTable(host, request, clock = systemClock) {
  const { table } = request;
  const asked = readArguments(request);
  if ("severity" in asked) return refused(asked);
  const { by, only, children } = asked;
  const mapped = mappedFields(request.section);
  if (!mapped.ok) return refused(verbFailed(mapped.error, REFRESH_VERB_ID));
  const jiraNames = /* @__PURE__ */ new Set([
    ...FIXED_COLUMNS.map((column) => column.name),
    ...mapped.value.map(({ column }) => column)
  ]);
  if (by !== void 0 && by.name !== "key" && jiraNames.has(by.name.toLowerCase())) {
    return refused(
      problem(`by= names ${by.name}, a column this verb writes; name key or a column of your own`)
    );
  }
  const keyOf = (row) => {
    const value = by === void 0 ? row.key : row.values[by.name];
    const key = typeof value === "string" ? value.trim() : void 0;
    return key !== void 0 && ISSUE_KEY.test(key) ? key : void 0;
  };
  const keys = [
    ...new Set(
      table.rows.filter((row) => only === void 0 || row.values[only.name] === true).map(keyOf).filter((key) => key !== void 0)
    )
  ];
  if (keys.length > MAX_KEYS) {
    return refused(
      narrow(
        `would refresh ${issueCount(keys.length)}, more than the ${count(MAX_KEYS)} one call takes`
      )
    );
  }
  const config = await resolveJiraConfig(host, request.section);
  if (!config.ok) return refused(verbFailed(config.error, REFRESH_VERB_ID));
  const deadline = clock.now() + BUDGET_MILLISECONDS;
  let overBudget = false;
  const client = createJiraClient({
    config: config.value,
    fetch: (url, init) => {
      if (clock.now() > deadline) {
        overBudget = true;
        return Promise.reject(new Error("the refresh ran out of time"));
      }
      return host.fetch(url, init);
    },
    sleep: async (milliseconds) => {
      if (clock.now() + milliseconds > deadline) overBudget = true;
      else await (clock.sleep ?? wait)(milliseconds);
    }
  });
  const jiraFailed = (error) => overBudget ? refused(
    narrow(
      `did not finish ${issueCount(keys.length)} within ${BUDGET_MILLISECONDS / 1e3} s`
    )
  ) : refused(verbFailed(error, REFRESH_VERB_ID));
  const types = await mappedTypes(client, mapped.value);
  if (!types.ok) return jiraFailed(types.error);
  const targets = [...FIXED_COLUMNS, ...mappedColumns(mapped.value, types.value)];
  const existing = new Map(table.columns.map((column) => [column.name.toLowerCase(), column]));
  for (const target of targets) {
    const column = existing.get(target.name);
    if (column !== void 0 && column.type !== target.type) {
      return refused(
        problem(
          `would write ${target.type} column ${target.name}, and the table's ${column.name} is ${column.type}; rename it before this step`
        )
      );
    }
  }
  const fields = [.../* @__PURE__ */ new Set([...FIXED_FIELDS, ...mapped.value.map(({ id }) => id)])];
  const found = await fetchIssues(client, keys, fields);
  if (!found.ok) return jiraFailed(found.error);
  const issues = /* @__PURE__ */ new Map();
  for (const issue of found.value.values()) issues.set(issue.key, issue);
  if (children) {
    const parents = [...new Set([...found.value.values()].map((issue) => issue.key))];
    const read2 = await childrenOf(client, parents, fields);
    if (!read2.ok) return jiraFailed(read2.error);
    if (read2.value === "too many") {
      return refused(
        narrow(`found more than ${count(MAX_CHILDREN)} children of ${issueCount(parents.length)}`)
      );
    }
    for (const child of read2.value) if (!issues.has(child.key)) issues.set(child.key, child);
  }
  const ordered = [...issues.values()];
  const read = await readIssues(client, ordered);
  if (!read.ok) return jiraFailed(read.error);
  const fetchedAt = new Date(clock.now()).toISOString();
  const nameOf = (name) => existing.get(name)?.name ?? name;
  const live = /* @__PURE__ */ new Map();
  for (const [index, issue] of ordered.entries()) {
    const row = issueRow(issue, read.value.comments[index] ?? [], read.value.parents, {
      baseUrl: config.value.baseUrl,
      fetchedAt,
      mapped: mapped.value,
      types: types.value
    });
    if (!row.ok) return jiraFailed(row.error);
    const values = {};
    for (const [name, value] of Object.entries(row.value.values)) values[nameOf(name)] = value;
    live.set(issue.key, {
      key: issue.key,
      values,
      provenance: { source: REFRESH_VERB_ID, id: issue.key, fetchedAt }
    });
  }
  const added = targets.filter((target) => !existing.has(target.name));
  const addedNulls = Object.fromEntries(added.map((column) => [column.name, null]));
  const jiraNulls = Object.fromEntries(targets.map((column) => [nameOf(column.name), null]));
  const askedKeys = new Set(keys);
  const rowKeys = new Set(table.rows.map((row) => row.key));
  const present = /* @__PURE__ */ new Set();
  const rows = table.rows.map((row) => {
    const key = keyOf(row);
    if (key === void 0) return { ...row, values: { ...addedNulls, ...row.values } };
    const issue = found.value.get(key) ?? issues.get(key);
    const fresh = issue === void 0 ? void 0 : live.get(issue.key);
    if (fresh !== void 0) {
      present.add(fresh.key);
      return { ...row, values: { ...row.values, ...fresh.values }, provenance: fresh.provenance };
    }
    if (!askedKeys.has(key)) return { ...row, values: { ...addedNulls, ...row.values } };
    const values = { ...row.values, ...jiraNulls };
    if (by !== void 0) values[by.name] = row.values[by.name] ?? null;
    return { ...row, values };
  });
  const emptyRow = Object.fromEntries(
    [...table.columns.map((column) => column.name), ...added.map((column) => column.name)].map(
      (name) => [name, null]
    )
  );
  for (const [key, fresh] of live) {
    if (present.has(key)) continue;
    if (rowKeys.has(key)) {
      return refused(
        problem(
          `would add child ${key}, which is already the key of a row with another ${by?.name ?? "key"}; two rows cannot share a key`
        )
      );
    }
    const values = { ...emptyRow, ...fresh.values };
    if (by !== void 0) values[by.name] = key;
    rows.push({ ...fresh, values });
  }
  return { ok: true, value: { columns: [...table.columns, ...added], rows }, diagnostics: [] };
}
function readArguments(request) {
  const columns = new Map(
    request.table.columns.map((column) => [column.name.toLowerCase(), column])
  );
  const columnOf = (name) => {
    const written = request.arguments[name];
    if (written === void 0) return void 0;
    const column = columns.get(String(written).trim().toLowerCase());
    return column ?? problem(`${name}= names '${String(written)}', which is not a column of the table`);
  };
  const by = columnOf("by");
  if (by !== void 0 && "severity" in by) return by;
  if (by !== void 0 && by.type !== "text") {
    return problem(`by= names ${by.name}, a ${by.type} column; an issue key is text`);
  }
  const only = columnOf("only");
  if (only !== void 0 && "severity" in only) return only;
  if (only !== void 0 && only.type !== "boolean") {
    return problem(
      `only= names ${only.name}, a ${only.type} column; name a true or false one, such as recall's mark=`
    );
  }
  return { by, only, children: request.arguments["children"] === true };
}
async function fetchIssues(client, keys, fields) {
  const answered = await bulkIssues(client, keys, fields);
  if (!answered.ok) return answered;
  const byKey = new Map(answered.value.issues.map((issue) => [issue.key, issue]));
  const found = /* @__PURE__ */ new Map();
  for (const key of keys) {
    const issue = byKey.get(key);
    if (issue !== void 0) {
      found.set(key, issue);
      continue;
    }
    if (answered.value.refused.has(key)) continue;
    const path = `/rest/api/3/issue/${encodeURIComponent(key)}`;
    const single = await client.get(path, { fields: fields.join(",") });
    if (!single.ok) {
      if (single.error.status === 404) continue;
      return single;
    }
    const moved = issueOf(single.value);
    if (moved === void 0) {
      return jiraError(
        "E_JIRA_RESPONSE",
        `GET ${path} answered an issue without an id, a key or fields.`
      );
    }
    found.set(key, moved);
  }
  return jiraOk(found);
}
async function childrenOf(client, parents, fields) {
  const children = [];
  for (let start = 0; start < parents.length; start += PARENTS_PER_SEARCH) {
    const jql = `parent in (${parents.slice(start, start + PARENTS_PER_SEARCH).join(", ")}) ORDER BY key ASC`;
    let token;
    for (; ; ) {
      const page = await searchPage(client, jql, fields, token);
      if (!page.ok) return page;
      children.push(...page.value.issues);
      if (children.length > MAX_CHILDREN) return jiraOk("too many");
      const next = page.value.nextPageToken;
      if (page.value.isLast || next === void 0) break;
      if (next === token) {
        return jiraError("E_JIRA_RESPONSE", "the children search answered the token it was given.");
      }
      token = next;
    }
  }
  return jiraOk(children);
}
function problem(text2) {
  return argumentsProblem(text2, REFRESH_VERB_ID);
}
function narrow(what) {
  return {
    severity: "error",
    code: "E_RECIPE_VERB",
    message: `'${REFRESH_VERB_ID}' ${what}; narrow it with only=.`
  };
}
function refused(diagnostic) {
  return { ok: false, error: [diagnostic] };
}
function issueCount(value) {
  return `${count(value)} ${value === 1 ? "issue" : "issues"}`;
}
function count(value) {
  return value.toLocaleString("en-US");
}
var wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// src/settings.ts
var SETTINGS = [
  {
    id: "baseUrl",
    form: { type: "string", nullable: true, format: "uri" },
    default: null,
    description: "The Jira Cloud site, such as https://example.atlassian.net. A workspace may name its own in the jira section of .tyto/project.json, which wins."
  },
  {
    id: "email",
    form: { type: "string", nullable: true, minLength: 3 },
    default: null,
    description: "The email the API token belongs to, when it is not stored as the email credential."
  }
];

// src/index.ts
function activate(host) {
  const registered = [
    ...SETTINGS.map((setting) => host.registerConfiguration(setting)),
    host.registerRecipeVerb(pullVerb(host)),
    host.registerRecipeVerb(refreshVerb(host))
  ];
  return {
    dispose() {
      for (const registration of registered) registration.dispose();
    }
  };
}
export {
  activate
};
