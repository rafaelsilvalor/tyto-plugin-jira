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
        const wait = retryWait(response, retry);
        if (retry < MAX_RETRIES && wait.milliseconds !== void 0) {
          await sleep(wait.milliseconds);
          continue;
        }
        const why = wait.milliseconds === void 0 ? `Jira asked to wait ${wait.seconds} s, longer than the ${MAX_RETRY_AFTER_SECONDS} s this plugin waits` : `still so after ${MAX_RETRIES} retries`;
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

// src/diagnostics.ts
var VERB_ID = "jira.pull";
function verbFailed(error) {
  return {
    severity: "error",
    code: "E_RECIPE_VERB",
    message: `'${VERB_ID}' failed: ${withoutFinalStop(describeJiraError(error))}.`
  };
}
function argumentsProblem(problem) {
  return {
    severity: "error",
    code: "E_RECIPE_ARGUMENTS",
    message: `'${VERB_ID}' ${withoutFinalStop(problem)}.`
  };
}
function failed(diagnostic) {
  return { ok: false, error: [diagnostic] };
}
function withoutFinalStop(text2) {
  return text2.trim().replace(/\.+$/, "");
}

// src/search.ts
var PAGE_SIZE = 50;
var COMMENT_PAGE_SIZE = 100;
var SEARCH_PATH = "/rest/api/3/search/jql";
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
  const answer = await client.post(SEARCH_PATH, {
    jql,
    fields,
    maxResults: PAGE_SIZE,
    ...token === void 0 ? {} : { nextPageToken: token }
  });
  if (!answer.ok) return answer;
  const body = record(answer.value);
  const issues = body?.["issues"];
  if (body === void 0 || !Array.isArray(issues)) {
    return shapeError(`POST ${SEARCH_PATH} answered no issues list`);
  }
  const pulled = [];
  for (const issue of issues) {
    const checked = issueOf(issue);
    if (checked === void 0) {
      return shapeError(`POST ${SEARCH_PATH} answered an issue without an id, a key or fields`);
    }
    pulled.push(checked);
  }
  const next = body["nextPageToken"];
  if (next !== void 0 && next !== null && (typeof next !== "string" || next === "")) {
    return shapeError(`POST ${SEARCH_PATH} answered a nextPageToken that is not text`);
  }
  const nextPageToken = typeof next === "string" ? next : void 0;
  const isLast = body["isLast"];
  if (isLast !== void 0 && typeof isLast !== "boolean") {
    return shapeError(`POST ${SEARCH_PATH} answered an isLast that is not true or false`);
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
  const answer = await client.post("/rest/api/3/issue/bulkfetch", {
    issueIdsOrKeys: [...missing],
    fields: ["description"]
  });
  if (!answer.ok) return answer;
  const fetched = record(answer.value)?.["issues"];
  if (!Array.isArray(fetched)) {
    return shapeError("POST /rest/api/3/issue/bulkfetch answered no issues list");
  }
  for (const issue of fetched) {
    const checked = issueOf(issue);
    if (checked !== void 0) descriptions.set(checked.key, checked.fields["description"]);
  }
  return jiraOk(descriptions);
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
  const client = createJiraClient({
    fetch: (url, init) => host.fetch(url, init),
    config: config.value
  });
  const jql = await jqlOf(client, asked.selector);
  if (!jql.ok) return failed(verbFailed(jql.error));
  const fields = FIXED_FIELDS;
  const requestPrint = fingerprint(JSON.stringify([config.value.baseUrl, jql.value, fields]));
  if (cursor !== void 0 && cursor.f !== requestPrint) {
    return failed(
      verbFailed({
        code: "E_JIRA_CONFIG",
        message: "the jira section changed during the pull; run again"
      })
    );
  }
  const page = await searchPage(client, jql.value, fields, cursor?.t);
  if (!page.ok) return failed(verbFailed(page.error));
  const parents = await parentDescriptions(client, page.value.issues);
  if (!parents.ok) return failed(verbFailed(parents.error));
  const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
  const rows = [];
  for (const issue of page.value.issues) {
    const comments = await commentBodies(client, issue);
    if (!comments.ok) return failed(verbFailed(comments.error));
    const parentKey = record(issue.fields["parent"])?.["key"];
    const parent = typeof parentKey === "string" ? parents.value.get(parentKey) : void 0;
    const row = rowOf(issue, {
      baseUrl: config.value.baseUrl,
      fetchedAt,
      commentBodies: comments.value,
      parentDescription: parent
    });
    if (!row.ok) return failed(verbFailed(row.error));
    rows.push(row.value);
  }
  const table = { columns: FIXED_COLUMNS, rows };
  const { isLast, nextPageToken } = page.value;
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
    m: {},
    g: 0,
    c: false
  });
  return { ok: true, value: { table, cursor: next }, diagnostics: [] };
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
    host.registerRecipeVerb(pullVerb(host))
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
