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
var TRANSITION_VERB_ID = "jira.transition";
var ASSIGN_VERB_ID = "jira.assign";
var SET_VERB_ID = "jira.set";
var COMMENT_VERB_ID = "jira.comment";
var CREATE_VERB_ID = "jira.create";
function verbFailed(error, verb = VERB_ID) {
  return {
    severity: "error",
    code: "E_RECIPE_VERB",
    message: `'${verb}' failed: ${withoutFinalStop(describeJiraError(error))}.`
  };
}
function argumentsProblem(problem7, verb = VERB_ID) {
  return {
    severity: "error",
    code: "E_RECIPE_ARGUMENTS",
    message: `'${verb}' ${withoutFinalStop(problem7)}.`
  };
}
function failed(diagnostic) {
  return { ok: false, error: [diagnostic] };
}
function withoutFinalStop(text2) {
  return text2.trim().replace(/\.+$/, "");
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
        const wait3 = retryWait(response, retry);
        if (retry < MAX_RETRIES && wait3.milliseconds !== void 0) {
          await sleep(wait3.milliseconds);
          continue;
        }
        const why = wait3.milliseconds === void 0 ? `Jira asked to wait ${wait3.seconds} s, longer than the ${MAX_RETRY_AFTER_SECONDS} s this plugin waits` : `still so after ${MAX_RETRIES} retries`;
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
    put: (path, body) => request("PUT", path, void 0, body),
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
        `Jira refused ${config.email} on ${config.baseUrl} (403): the account may not do ${label}, or Jira wants a CAPTCHA after failed sign-ins (sign in on the site once). ` + quotedBody(await bodyText(response))
      ).trim(),
      { status }
    );
  }
  if (status < 200 || status >= 300) {
    const text3 = await bodyText(response);
    const body = parsedOrUndefined(text3);
    return jiraError(
      "E_JIRA_HTTP",
      redact(`${label} answered ${statusOf(response)}. ${quotedBody(text3)}`).trim(),
      { status, ...body === void 0 ? {} : { body } }
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
async function bodyText(response) {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
function parsedOrUndefined(text2) {
  try {
    return text2 === "" ? void 0 : JSON.parse(text2);
  } catch {
    return void 0;
  }
}
function quotedBody(text2) {
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
    return jiraOk(comments.map((comment2) => record(comment2)?.["body"]));
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
    const answered2 = record(page.value)?.["comments"];
    if (!Array.isArray(answered2)) return shapeError(`GET ${path} answered no comments list`);
    if (answered2.length === 0) break;
    bodies.push(...answered2.map((comment2) => record(comment2)?.["body"]));
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
      const named2 = record(error)?.["issueIdsOrKeys"];
      for (const key of Array.isArray(named2) ? named2 : []) {
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
var SEARCH_PATH2 = "/rest/api/3/search/jql";
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
    const comment2 = COMMENT_PATH.exec(path)?.[1];
    if (path === SEARCH_PATH2) search = value;
    else if (path === BULK_PATH) parents = value;
    else if (comment2 !== void 0) (comments[comment2] ??= []).push(value);
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
      // A page only reads: a write passes through, never recorded.
      put: (path, body) => client.put(path, body),
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
    if (path === SEARCH_PATH2) return jiraOk(raw.search);
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
    put: async () => missing(),
    myself: async () => missing()
  };
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
  const named2 = catalogue.filter((field) => typeof field["name"] === "string" && field["name"].toLowerCase() === lowered).map((field) => field["id"]).filter((id) => typeof id === "string");
  if (named2.length === 0) {
    return `fields maps ${column} to '${written}', and this site has no field with that id`;
  }
  return `fields maps ${column} to '${written}', which is a field's name, not its id; write ` + named2.join(" or ");
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
    const shown2 = object?.[name];
    if (typeof shown2 === "string") return shown2;
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
function projected(value) {
  if (value === void 0 || value === null || value === "") return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return value.map((item) => typeof item === "number" ? item : textOf(item));
  }
  if (typeof value === "number") return value;
  return textOf(value);
}
function chosenBy(row, column) {
  const cell = row.values[column.name] ?? null;
  if (column.type === "boolean") return cell === true;
  const shown2 = projected(cell);
  return shown2 !== null && (typeof shown2 !== "string" || shown2.trim() !== "");
}
function configError(message) {
  return jiraError("E_JIRA_CONFIG", `${message}.`);
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

// src/write/plan.ts
var MAX_DESCRIPTION_LENGTH = 500;
var MAX_PAYLOAD_BYTES = 2048;
function plannedOperation(write, rowKey, description, payload) {
  const bytes = payloadBytes(payload);
  if (bytes > MAX_PAYLOAD_BYTES) {
    const key = typeof payload["k"] === "string" ? `${payload["k"]}: ` : "";
    return plannedFailure(
      write,
      rowKey,
      description,
      `E_JIRA_PLAN: ${key}this write needs ${bytes.toLocaleString("en-US")} bytes to be kept with the plan, over the ${MAX_PAYLOAD_BYTES.toLocaleString("en-US")} a plan keeps per row; shorten what it writes`
    );
  }
  return { write, rowKey, description: shortened(description), payload };
}
function plannedFailure(write, rowKey, description, reason) {
  return {
    write,
    rowKey,
    description: shortened(`${description} (will fail: ${reason})`),
    payload: { x: shortened(reason) }
  };
}
function issueKeyOf(row) {
  for (const candidate of [row.values["key"], row.key]) {
    const key = typeof candidate === "string" ? candidate.trim() : void 0;
    if (key !== void 0 && ISSUE_KEY.test(key)) return key;
  }
  return void 0;
}
function columnNamed(table, name) {
  const wanted = name.toLowerCase();
  return table.columns.find((column) => column.name.toLowerCase() === wanted);
}
function planOf(target, operations) {
  const plan = { target, operations, count: operations.length };
  return { ok: true, value: plan, diagnostics: [] };
}
function planRefused(diagnostic) {
  return { ok: false, error: [diagnostic] };
}
function payloadBytes(payload) {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}
function shortened(text2, limit = MAX_DESCRIPTION_LENGTH) {
  return text2.length <= limit ? text2 : `${text2.slice(0, limit - 1)}\u2026`;
}

// src/write/apply.ts
var systemClock = { now: () => Date.now() };
var APPLY_BUDGET_MILLISECONDS = 2e4;
var NOT_REACHED = "not reached in this call's time; run the cell and Apply again";
async function openSession(host, request, clock = systemClock) {
  const config = await resolveJiraConfig(host, request.section);
  if (!config.ok) return config;
  const { token } = config.value;
  const redact = (text2) => token === "" ? text2 : text2.split(token).join("[redacted]");
  const deadline = clock.now() + APPLY_BUDGET_MILLISECONDS;
  let outOfTime = false;
  const expired = () => {
    if (clock.now() > deadline) outOfTime = true;
    return outOfTime;
  };
  const client = createJiraClient({
    config: config.value,
    fetch: (url, init) => expired() ? Promise.reject(new Error(NOT_REACHED)) : host.fetch(url, init),
    sleep: async (milliseconds) => {
      if (clock.now() + milliseconds > deadline) outOfTime = true;
      else await (clock.sleep ?? wait)(milliseconds);
    }
  });
  return jiraOk({
    config: config.value,
    client,
    expired,
    finished: (outcome) => outcome.reason === void 0 ? outcome : { ...outcome, reason: shortened(redact(outcome.reason)) }
  });
}
var DRIFT_FIELDS = ["status", "assignee", "updated"];
async function applyBatch(host, request, verb, clock = systemClock) {
  const { operations } = request;
  const session = await openSession(host, request, clock);
  if (!session.ok) return answered(operations.map(() => failedWith(session.error)));
  const { client, config, finished, expired } = session.value;
  const decoded = operations.map((operation) => decodeOperation(operation.payload, verb));
  const keys = [
    ...new Set(
      decoded.flatMap((each) => typeof each === "object" && "k" in each ? [each.k] : [])
    )
  ];
  const extra = verb.fields?.(decoded.filter((each) => typeof each === "object")) ?? [];
  const read = keys.length === 0 ? jiraOk(/* @__PURE__ */ new Map()) : await currentIssues(client, keys, extra);
  const context = read.ok ? { client, config, current: read.value } : void 0;
  let refused2;
  const outcomes = [];
  for (const each of decoded) {
    if (typeof each === "string") {
      outcomes.push(finished({ status: "failed", reason: each }));
      continue;
    }
    if (!read.ok) {
      outcomes.push(finished(failedWith(read.error)));
      continue;
    }
    if (expired()) {
      outcomes.push({ status: "skipped", reason: NOT_REACHED });
      continue;
    }
    if (refused2 !== void 0) {
      outcomes.push(finished({ status: "failed", reason: refused2 }));
      continue;
    }
    const issue = context?.current.get(each.k);
    if (issue === void 0 || context === void 0) {
      outcomes.push(
        finished({
          status: "failed",
          reason: `E_JIRA_MOVED: ${each.k} was not found; it may have been deleted, moved to another project or hidden from this account since the plan`
        })
      );
      continue;
    }
    const outcome = finished(await verb.write(each, issue, context));
    if (outcome.status === "failed" && outcome.reason?.startsWith("E_JIRA_AUTH") === true) {
      refused2 = outcome.reason;
    }
    outcomes.push(outcome);
  }
  return answered(outcomes);
}
function decodeOperation(payload, verb) {
  const object = record(payload);
  if (object === void 0) return UNREADABLE;
  const planned = object["x"];
  if (typeof planned === "string") return planned;
  return verb.decode(object) ?? UNREADABLE;
}
var UNREADABLE = "E_JIRA_PLAN: this operation carries no payload this version of the plugin reads; run the cell again";
async function currentIssues(client, keys, extra) {
  const found = /* @__PURE__ */ new Map();
  const jql = `key in (${keys.join(", ")})`;
  const fields = [.../* @__PURE__ */ new Set([...DRIFT_FIELDS, ...extra])];
  let token;
  for (; ; ) {
    const page = await searchPage(client, jql, fields, token);
    if (!page.ok) return page;
    for (const issue of page.value.issues) {
      const status = record(issue.fields["status"])?.["name"];
      const assignee = record(issue.fields["assignee"]);
      const accountId = assignee?.["accountId"];
      const displayName = assignee?.["displayName"];
      const updated = issue.fields["updated"];
      found.set(issue.key, {
        key: issue.key,
        status: typeof status === "string" ? status : null,
        assignee: typeof accountId === "string" ? { accountId, displayName: typeof displayName === "string" ? displayName : null } : null,
        updated: typeof updated === "string" ? updated : null,
        fields: Object.fromEntries(extra.map((id) => [id, issue.fields[id] ?? null]))
      });
    }
    const next = page.value.nextPageToken;
    if (page.value.isLast || next === void 0) return jiraOk(found);
    if (next === token) {
      return jiraError(
        "E_JIRA_RESPONSE",
        "the search for the batch answered the token it was given."
      );
    }
    token = next;
  }
}
function failedWith(error, suffix = "") {
  return { status: "failed", reason: `${describeJiraError(error)}${suffix}` };
}
function answered(operations) {
  return { ok: true, value: { operations }, diagnostics: [] };
}
function same(left, right) {
  return (left ?? "").trim().toLowerCase() === (right ?? "").trim().toLowerCase();
}
var wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// src/assign.ts
var ASSIGN_WRITE = "assign";
var ARGUMENTS2 = [{ name: "to", type: "text", required: true }];
var ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
function assignVerb(host, clock = systemClock) {
  return {
    id: ASSIGN_VERB_ID,
    kind: "action",
    arguments: ARGUMENTS2,
    writes: [ASSIGN_WRITE],
    plan: (request) => planAssignments(host, request),
    apply: (request) => applyAssignments(host, request, clock)
  };
}
async function planAssignments(host, request) {
  const { table } = request;
  const written = String(request.arguments["to"] ?? "").trim();
  let target;
  if (written.toLowerCase() === "me") target = { kind: "me" };
  else if (written.toLowerCase() === "none") target = { kind: "none" };
  else {
    const column = columnNamed(table, written);
    if (column === void 0) {
      return planRefused(
        problem(
          `to= names '${written}', which is neither me, none nor a column of the table holding account ids`
        )
      );
    }
    if (column.type !== "text") {
      return planRefused(
        problem(`to= names ${column.name}, a ${column.type} column; an account id is text`)
      );
    }
    target = { kind: "column", column };
  }
  const assignee = columnNamed(table, "assignee");
  const config = await resolveJiraConfig(host, request.section);
  if (!config.ok) return planRefused(verbFailed(config.error, ASSIGN_VERB_ID));
  const operations = [];
  for (const row of table.rows) {
    const key = issueKeyOf(row) ?? row.key;
    const fail = (description, reason) => {
      operations.push(plannedFailure(ASSIGN_WRITE, row.key, description, reason));
    };
    if (issueKeyOf(row) === void 0) {
      fail(
        `${row.key}: assign`,
        `E_JIRA_PLAN: row ${row.key} names no issue key in its key column or its key`
      );
      continue;
    }
    const from = assignee === void 0 ? void 0 : row.values[assignee.name];
    const drift = assignee === void 0 ? {} : { f: typeof from === "string" && from.trim() !== "" ? from : null };
    const before = typeof from === "string" && from.trim() !== "" ? `${from} \u2192 ` : "";
    if (target.kind === "me") {
      operations.push(
        plannedOperation(ASSIGN_WRITE, row.key, `${key}: ${before}the token's own account`, {
          k: key,
          ...drift,
          me: true
        })
      );
      continue;
    }
    if (target.kind === "none") {
      operations.push(
        plannedOperation(ASSIGN_WRITE, row.key, `${key}: ${before}unassigned`, {
          k: key,
          ...drift,
          t: null
        })
      );
      continue;
    }
    const value = row.values[target.column.name];
    const accountId = typeof value === "string" ? value.trim() : "";
    if (accountId === "") {
      fail(`${key}: assign`, `E_JIRA_PLAN: ${key} has no account id in ${target.column.name}`);
      continue;
    }
    if (!ACCOUNT_ID.test(accountId)) {
      fail(
        `${key}: assign`,
        `E_JIRA_PLAN: ${JSON.stringify(accountId.slice(0, 80))} in ${target.column.name} is not a Jira account id; write the id, not a name or an email`
      );
      continue;
    }
    operations.push(
      plannedOperation(ASSIGN_WRITE, row.key, `${key}: ${before}${accountId}`, {
        k: key,
        ...drift,
        t: accountId
      })
    );
  }
  return planOf(`Jira ${new URL(config.value.baseUrl).hostname}`, operations);
}
function applyAssignments(host, request, clock = systemClock) {
  let me;
  return applyBatch(
    host,
    request,
    {
      decode,
      async write(planned, issue, context) {
        if (planned.me === true && me === void 0) {
          const account = await context.client.myself();
          if (!account.ok) return failedWith(account.error);
          me = account.value.accountId;
        }
        return assign(
          planned,
          planned.me === true ? me : planned.t ?? null,
          issue,
          context
        );
      }
    },
    clock
  );
}
function decode(payload) {
  const { k, f, t, me } = payload;
  if (typeof k !== "string") return void 0;
  if (f !== void 0 && f !== null && typeof f !== "string") return void 0;
  const drift = f === void 0 ? {} : { f };
  if (me === true) return { k, ...drift, me: true };
  if (t === null || typeof t === "string") return { k, ...drift, t };
  return void 0;
}
async function assign(planned, accountId, issue, context) {
  const key = planned.k;
  const now = issue.assignee;
  if (now?.accountId === accountId || now === null && accountId === null) {
    return {
      status: "applied",
      reason: `already ${accountId === null ? "unassigned" : `assigned to ${now?.displayName ?? accountId}`}; nothing written`
    };
  }
  if (planned.f !== void 0 && !same(now?.displayName ?? null, planned.f)) {
    return {
      status: "failed",
      reason: `E_JIRA_MOVED: ${key} was assigned to ${planned.f ?? "nobody"} when planned and is assigned to ${now?.displayName ?? "nobody"} now; run the cell again`
    };
  }
  const path = `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`;
  const put = await context.client.put(path, { accountId });
  if (!put.ok) return failedWith(put.error);
  issue.assignee = accountId === null ? null : { accountId, displayName: null };
  return { status: "applied" };
}
function problem(text2) {
  return argumentsProblem(text2, ASSIGN_VERB_ID);
}

// src/write/adf.ts
var PARAGRAPH_BREAK = /\n[ \t]*\n+/;
var ADDRESS = /https?:\/\/[^\s<>"]+/g;
var TRAILING = /[.,;:!?)\]'"]+$/;
function textToAdf(text2) {
  const paragraphs = text2.replace(/\r\n?/g, "\n").split(PARAGRAPH_BREAK).map((paragraph) => paragraph.replace(/^\n+|\n+$/g, "")).filter((paragraph) => paragraph.trim() !== "");
  return {
    type: "doc",
    version: 1,
    content: paragraphs.map((paragraph) => ({
      type: "paragraph",
      content: paragraph.split("\n").flatMap(
        (line, index) => index === 0 ? linked(line) : [{ type: "hardBreak" }, ...linked(line)]
      )
    }))
  };
}
function linked(line) {
  const nodes = [];
  let from = 0;
  for (const match of line.matchAll(ADDRESS)) {
    const address = match[0].replace(TRAILING, "");
    const start = match.index;
    if (start > from) nodes.push({ type: "text", text: line.slice(from, start) });
    nodes.push({
      type: "text",
      text: address,
      marks: [{ type: "link", attrs: { href: address } }]
    });
    from = start + address.length;
  }
  if (from < line.length) nodes.push({ type: "text", text: line.slice(from) });
  return nodes;
}

// src/comment.ts
var COMMENT_WRITE = "comment";
var MAX_COMMENT_BYTES = 1500;
var RECENT_COMMENTS = 50;
var ARGUMENTS3 = [{ name: "body", type: "text", required: true }];
function commentVerb(host, clock = systemClock) {
  return {
    id: COMMENT_VERB_ID,
    kind: "action",
    arguments: ARGUMENTS3,
    writes: [COMMENT_WRITE],
    plan: (request) => planComments(host, request),
    apply: (request) => applyComments(host, request, clock)
  };
}
async function planComments(host, request) {
  const { table } = request;
  const written = String(request.arguments["body"] ?? "").trim();
  const column = columnNamed(table, written);
  if (column === void 0) {
    return planRefused(problem2(`body= names '${written}', which is not a column of the table`));
  }
  if (column.type !== "text") {
    return planRefused(
      problem2(`body= names ${column.name}, a ${column.type} column; a comment is text`)
    );
  }
  const config = await resolveJiraConfig(host, request.section);
  if (!config.ok) return planRefused(verbFailed(config.error, COMMENT_VERB_ID));
  const operations = [];
  for (const row of table.rows) {
    const key = issueKeyOf(row);
    const fail = (reason) => {
      operations.push(plannedFailure(COMMENT_WRITE, row.key, `${key ?? row.key}: comment`, reason));
    };
    if (key === void 0) {
      fail(`E_JIRA_PLAN: row ${row.key} names no issue key in its key column or its key`);
      continue;
    }
    const value = row.values[column.name];
    const text2 = typeof value === "string" ? value.trim() : "";
    if (text2 === "") {
      fail(`E_JIRA_PLAN: ${key} has no text in ${column.name}`);
      continue;
    }
    const bytes = new TextEncoder().encode(text2).byteLength;
    if (bytes > MAX_COMMENT_BYTES) {
      fail(
        `E_JIRA_PLAN: ${key}'s comment is ${bytes.toLocaleString("en-US")} bytes, over the ${MAX_COMMENT_BYTES.toLocaleString("en-US")} a plan carries; shorten it`
      );
      continue;
    }
    const preview = shortened(text2.replace(/\s+/g, " "), 80);
    operations.push(
      plannedOperation(COMMENT_WRITE, row.key, `${key}: comment "${preview}"`, { k: key, b: text2 })
    );
  }
  return planOf(`Jira ${new URL(config.value.baseUrl).hostname}`, operations);
}
function applyComments(host, request, clock = systemClock) {
  let me;
  return applyBatch(
    host,
    request,
    {
      decode: decode2,
      async write(planned, _issue, context) {
        if (me === void 0) {
          const account = await context.client.myself();
          if (!account.ok) return failedWith(account.error);
          me = account.value.accountId;
        }
        return comment(planned, me, context);
      }
    },
    clock
  );
}
function decode2(payload) {
  const { k, b } = payload;
  return typeof k === "string" && typeof b === "string" ? { k, b } : void 0;
}
async function comment(planned, me, context) {
  const path = `/rest/api/3/issue/${encodeURIComponent(planned.k)}/comment`;
  const body = textToAdf(planned.b);
  const wanted = fingerprint(textOf(body));
  const recent = await context.client.get(path, {
    orderBy: "-created",
    maxResults: RECENT_COMMENTS
  });
  if (!recent.ok) return failedWith(recent.error);
  const comments = record(recent.value)?.["comments"];
  const left = (Array.isArray(comments) ? comments : []).some((each) => {
    const existing = record(each);
    return record(existing?.["author"])?.["accountId"] === me && fingerprint(textOf(existing?.["body"] ?? "")) === wanted;
  });
  if (left) return { status: "applied", reason: "already commented; nothing written" };
  const posted = await context.client.post(path, { body });
  if (!posted.ok) return failedWith(posted.error);
  return { status: "applied" };
}
function problem2(text2) {
  return argumentsProblem(text2, COMMENT_VERB_ID);
}

// src/write/catalogue.ts
var FIELD_CATALOGUE2 = "/rest/api/3/field";
function catalogueKey(config) {
  return `jira/field/v1/${new URL(config.baseUrl).host}/${fingerprint(config.email)}`;
}
async function fieldCatalogue(host, client, config, now, verb = "jira.set") {
  const key = catalogueKey(config);
  try {
    const stored = await host.cache.get(key);
    const age = stored === void 0 ? NaN : now - Date.parse(stored.storedAt);
    const fields2 = stored === void 0 ? void 0 : entryOf2(stored.bytes);
    if (stored !== void 0 && fields2 === void 0) {
      host.log.warn(`${verb} ignored a field catalogue entry it did not write`);
    } else if (fields2 !== void 0 && age >= 0 && age < FRESH_MILLISECONDS) {
      return jiraOk(fields2);
    }
  } catch (thrown) {
    host.log.warn(`${verb} read no cached field catalogue: ${messageOf(thrown)}`);
  }
  const answer = await client.get(FIELD_CATALOGUE2);
  if (!answer.ok) return answer;
  if (!Array.isArray(answer.value)) {
    return jiraError("E_JIRA_RESPONSE", `GET ${FIELD_CATALOGUE2} answered no list of fields.`);
  }
  const fields = answer.value.flatMap((each) => fieldOf(each) ?? []);
  try {
    await host.cache.put(key, new TextEncoder().encode(JSON.stringify({ v: 1, fields })));
  } catch (thrown) {
    host.log.warn(`${verb} cached no field catalogue: ${messageOf(thrown)}`);
  }
  return jiraOk(fields);
}
function fieldOf(value) {
  const field = record(value);
  const id = field?.["id"];
  if (typeof id !== "string") return void 0;
  const name = field?.["name"];
  const schema = record(field?.["schema"]);
  const text2 = (key) => typeof schema?.[key] === "string" ? { [key]: schema[key] } : {};
  return {
    id,
    name: typeof name === "string" ? name : id,
    schema: { ...text2("type"), ...text2("items"), ...text2("custom") }
  };
}
function entryOf2(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return void 0;
  }
  const entry = record(parsed);
  const fields = entry?.["fields"];
  if (entry?.["v"] !== 1 || !Array.isArray(fields)) return void 0;
  const read = fields.map(fieldOf);
  return read.every((field) => field !== void 0) ? read : void 0;
}

// src/set.ts
var SET_WRITE = "field";
var ARGUMENTS4 = [
  { name: "field", type: "text", required: true },
  { name: "value", type: "text", required: true },
  { name: "only", type: "text" },
  { name: "from-column", type: "text" }
];
var BUILT_IN = {
  summary: { type: "string" },
  labels: { type: "array", items: "string" },
  duedate: { type: "date" },
  priority: { type: "priority" }
};
var TEXTAREA = ":textarea";
var DATE = /^\d{4}-\d{2}-\d{2}$/;
function setVerb(host, clock = systemClock) {
  return {
    id: SET_VERB_ID,
    kind: "action",
    arguments: ARGUMENTS4,
    writes: [SET_WRITE],
    plan: (request) => planSets(host, request, clock),
    apply: (request) => applySets(host, request, clock)
  };
}
async function planSets(host, request, clock = systemClock) {
  const { table } = request;
  const field = String(request.arguments["field"] ?? "").trim();
  const valueName = String(request.arguments["value"] ?? "").trim();
  const valueColumn = columnNamed(table, valueName);
  if (valueColumn === void 0) {
    return planRefused(problem3(`value= names '${valueName}', which is not a column of the table`));
  }
  const onlyName = request.arguments["only"];
  const only = onlyName === void 0 ? void 0 : columnNamed(table, String(onlyName).trim());
  if (onlyName !== void 0 && only === void 0) {
    return planRefused(
      problem3(`only= names '${String(onlyName)}', which is not a column of the table`)
    );
  }
  const fromName = request.arguments["from-column"];
  const readFrom = fromName === void 0 ? void 0 : columnNamed(table, String(fromName).trim());
  if (fromName !== void 0 && readFrom === void 0) {
    return planRefused(
      problem3(`from-column= names '${String(fromName)}', which is not a column of the table`)
    );
  }
  const config = await resolveJiraConfig(host, request.section);
  if (!config.ok) return planRefused(verbFailed(config.error, SET_VERB_ID));
  const mapped = mappedFields(request.section);
  if (!mapped.ok) return planRefused(verbFailed(mapped.error, SET_VERB_ID));
  const name = field.toLowerCase();
  const mapping = mapped.value.find((each) => each.column === name);
  let schema = BUILT_IN[name];
  let id = name;
  if (mapping !== void 0) {
    const client = createJiraClient({ config: config.value, fetch: host.fetch });
    const catalogue = await fieldCatalogue(host, client, config.value, clock.now());
    if (!catalogue.ok) return planRefused(verbFailed(catalogue.error, SET_VERB_ID));
    const found = catalogue.value.find((each) => each.id === mapping.id);
    if (found === void 0) {
      return planRefused(
        problem3(`field= names ${name}, mapped to ${mapping.id}, and this site has no such field`)
      );
    }
    schema = found.schema;
    id = mapping.id;
  }
  if (schema === void 0) {
    return planRefused(
      problem3(
        `field= names '${field}', which is neither a column the fields of the jira section map nor summary, labels, duedate or priority`
      )
    );
  }
  const kind = kindOf(schema);
  if (kind === void 0) {
    const type = schema.items === void 0 ? schema.type : `${schema.type} of ${schema.items}`;
    return planRefused(
      problem3(`field= names ${name}, a field of type ${type ?? "unknown"}, which it cannot write`)
    );
  }
  const target = { id, name, kind };
  const before = readFrom ?? columnNamed(table, name);
  const operations = [];
  for (const row of table.rows) {
    if (only !== void 0 && !chosenBy(row, only)) continue;
    const key = issueKeyOf(row);
    if (key === void 0) {
      operations.push(
        plannedFailure(
          SET_WRITE,
          row.key,
          `${row.key}: set ${name}`,
          `E_JIRA_PLAN: row ${row.key} names no issue key in its key column or its key`
        )
      );
      continue;
    }
    const value = converted(target, row.values[valueColumn.name] ?? null);
    if (typeof value === "string") {
      operations.push(
        plannedFailure(SET_WRITE, row.key, `${key}: set ${name}`, `E_JIRA_PLAN: ${key}: ${value}`)
      );
      continue;
    }
    const from = before === void 0 ? void 0 : projected(row.values[before.name] ?? null);
    const change = from === void 0 ? shown(value.v) : `${shown(from)} \u2192 ${shown(value.v)}`;
    operations.push(
      plannedOperation(SET_WRITE, row.key, `${key}: ${name} ${change}`, {
        k: key,
        fid: id,
        ...from === void 0 ? {} : { h: hashOf(from) },
        v: value.v
      })
    );
  }
  return planOf(`Jira ${new URL(config.value.baseUrl).hostname}`, operations);
}
function kindOf(schema) {
  switch (schema.type) {
    case "string":
      return schema.custom?.endsWith(TEXTAREA) === true ? "textarea" : "text";
    case "number":
    case "date":
    case "option":
    case "user":
    case "priority":
      return schema.type;
    case "array":
      if (schema.items === "string") return "labels";
      if (schema.items === "option") return "options";
      return void 0;
    default:
      return void 0;
  }
}
function converted(target, cell) {
  const empty = projected(cell) === null;
  const text2 = Array.isArray(cell) ? cell.map(String).join(", ") : String(cell ?? "").trim();
  switch (target.kind) {
    case "labels":
    case "options": {
      const items = (Array.isArray(cell) ? cell.map(String) : text2.split(",")).flatMap(
        (item) => target.kind === "labels" ? item.split(/[\s,]+/) : [item]
      );
      const kept = items.map((item) => item.trim()).filter((item) => item !== "");
      return { v: target.kind === "labels" ? kept : kept.map((value) => ({ value })) };
    }
    case "text":
      if (empty && target.id === "summary") return "a summary cannot be empty";
      return { v: empty ? null : text2 };
    case "textarea":
      return { v: empty ? null : textToAdf(text2) };
    case "number": {
      if (empty) return { v: null };
      const number = typeof cell === "number" ? cell : Number(text2);
      if (text2 === "" || !Number.isFinite(number)) {
        return `${JSON.stringify(text2.slice(0, 80))} is not a number for ${target.name}`;
      }
      return { v: number };
    }
    case "date":
      if (empty) return { v: null };
      if (!DATE.test(text2)) {
        return `${JSON.stringify(text2.slice(0, 80))} is not a date, such as 2026-10-01, for ${target.name}`;
      }
      return { v: text2 };
    case "option":
      return { v: empty ? null : { value: text2 } };
    case "priority":
      if (empty) return "a priority cannot be empty";
      return { v: { name: text2 } };
    case "user":
      if (empty) return { v: null };
      if (!ACCOUNT_ID.test(text2)) {
        return `${JSON.stringify(text2.slice(0, 80))} is not a Jira account id for ${target.name}; write the id, not a name or an email`;
      }
      return { v: { accountId: text2 } };
  }
}
function shown(value) {
  const accountId = record(value)?.["accountId"];
  const cell = projected(value);
  const text2 = typeof accountId === "string" ? accountId : Array.isArray(cell) ? cell.join(", ") : textOf(cell ?? "(empty)");
  return shortened(text2, 80);
}
function hashOf(cell) {
  return fingerprint(JSON.stringify(cell));
}
function applySets(host, request, clock = systemClock) {
  return applyBatch(
    host,
    request,
    {
      decode: decode3,
      fields: (planned) => planned.map((each) => each.fid),
      write: set
    },
    clock
  );
}
function decode3(payload) {
  const { k, fid, h, v } = payload;
  if (typeof k !== "string" || typeof fid !== "string" || v === void 0) return void 0;
  if (h !== void 0 && typeof h !== "string") return void 0;
  return { k, fid, ...h === void 0 ? {} : { h }, v };
}
async function set(planned, issue, context) {
  const { k: key, fid } = planned;
  const now = issue.fields[fid] ?? null;
  if (holds(now, planned.v)) {
    return { status: "applied", reason: `already ${fid} = ${shown(now)}; nothing written` };
  }
  if (planned.h !== void 0 && hashOf(projected(now)) !== planned.h) {
    return {
      status: "failed",
      reason: `E_JIRA_MOVED: ${key}'s ${fid} is ${shown(now)} now, not what the table read when planned; run the cell again`
    };
  }
  const put = await context.client.put(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
    fields: { [fid]: planned.v }
  });
  if (!put.ok) return failedWith(put.error);
  issue.fields[fid] = planned.v;
  return { status: "applied" };
}
function holds(current, wanted) {
  if (wanted === null) return projected(current) === null;
  if (Array.isArray(wanted)) {
    const items = Array.isArray(current) ? current : [];
    return items.length === wanted.length && wanted.every((each) => items.some((item) => holds(item, each)));
  }
  const object = record(wanted);
  if (object === void 0) return current === wanted;
  if (object["type"] === "doc") return projected(current) === projected(wanted);
  for (const name of ["accountId", "value", "name"]) {
    if (typeof object[name] === "string") return record(current)?.[name] === object[name];
  }
  return false;
}
function problem3(text2) {
  return argumentsProblem(text2, SET_VERB_ID);
}

// src/create.ts
var CREATE_WRITE = "create";
var BULK_CREATE_SIZE = 50;
var MAX_SUMMARY_LENGTH = 255;
var MAX_DESCRIPTION_BYTES = 1500;
var BULK_CREATE = "/rest/api/3/issue/bulk";
var PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;
var ARGUMENTS5 = [
  { name: "project", type: "text", required: true },
  { name: "type", type: "text", required: true },
  { name: "summary", type: "text", required: true },
  { name: "description", type: "text", required: false },
  { name: "parent", type: "text", required: false }
];
function createVerb(host, clock = systemClock) {
  return {
    id: CREATE_VERB_ID,
    kind: "action",
    arguments: ARGUMENTS5,
    writes: [CREATE_WRITE],
    plan: (request) => planCreates(host, request, clock),
    apply: (request) => applyCreates(host, request, clock)
  };
}
function creationLabel(site, project, rowKey) {
  return `tyto-${fingerprint(JSON.stringify([site, project, rowKey]))}`;
}
async function planCreates(host, request, clock = systemClock) {
  const { table } = request;
  const project = String(request.arguments["project"] ?? "").trim();
  const type = String(request.arguments["type"] ?? "").trim();
  if (!PROJECT_KEY.test(project)) {
    return planRefused(problem4(`project= is '${project}', which is not a project key, such as EX`));
  }
  if (type === "") return planRefused(problem4("type= names no issue type, such as Task"));
  const columns = {};
  for (const name of ["summary", "description", "parent"]) {
    const written = request.arguments[name];
    if (written === void 0 || written === null) continue;
    const column = columnNamed(table, String(written).trim());
    if (column === void 0) {
      return planRefused(
        problem4(`${name}= names '${String(written)}', which is not a column of the table`)
      );
    }
    columns[name] = column.name;
  }
  const config = await resolveJiraConfig(host, request.section);
  if (!config.ok) return planRefused(verbFailed(config.error, CREATE_VERB_ID));
  const named2 = Object.values(columns);
  const targets = await mappedTargets(host, config.value, request.section, table, named2, clock);
  if (!targets.ok) return planRefused(targets.error);
  const site = new URL(config.value.baseUrl).hostname;
  const operations = [];
  for (const row of table.rows) {
    const summary = cellText(columns.summary === void 0 ? null : row.values[columns.summary]);
    const preview = shortened(summary.replace(/\s+/g, " "), 80);
    const described = `${project}: create ${type} "${preview}"`;
    const fail = (reason) => {
      operations.push(plannedFailure(CREATE_WRITE, row.key, described, reason));
    };
    const why = `E_JIRA_PLAN: row ${row.key}`;
    if (summary === "") {
      fail(`${why} has no text in ${columns.summary ?? "the summary column"}`);
      continue;
    }
    if (summary.length > MAX_SUMMARY_LENGTH) {
      fail(
        `${why}'s summary is ${summary.length} characters, over the ${MAX_SUMMARY_LENGTH} Jira takes`
      );
      continue;
    }
    const description = cellText(
      columns.description === void 0 ? null : row.values[columns.description]
    );
    const bytes = new TextEncoder().encode(description).byteLength;
    if (bytes > MAX_DESCRIPTION_BYTES) {
      fail(
        `${why}'s description is ${bytes.toLocaleString("en-US")} bytes, over the ${MAX_DESCRIPTION_BYTES.toLocaleString("en-US")} a plan carries; shorten it`
      );
      continue;
    }
    const parent = cellText(columns.parent === void 0 ? null : row.values[columns.parent]);
    if (parent !== "" && !ISSUE_KEY.test(parent)) {
      fail(`${why}'s parent ${JSON.stringify(parent.slice(0, 80))} is not an issue key`);
      continue;
    }
    const mapped = {};
    let refused2;
    for (const target of targets.value) {
      const cell = row.values[target.column] ?? null;
      if (projected(cell) === null) continue;
      const value = converted(target, cell);
      if (typeof value === "string") {
        refused2 = `${why}: ${value}`;
        break;
      }
      mapped[target.id] = value.v;
    }
    if (refused2 !== void 0) {
      fail(refused2);
      continue;
    }
    operations.push(
      plannedOperation(
        CREATE_WRITE,
        row.key,
        parent === "" ? described : `${described} under ${parent}`,
        {
          p: project,
          t: type,
          s: summary,
          ...description === "" ? {} : { d: description },
          ...parent === "" ? {} : { par: parent },
          m: mapped,
          tok: creationLabel(site, project, row.key)
        }
      )
    );
  }
  return planOf(`Jira ${site}`, operations);
}
async function mappedTargets(host, config, section, table, named2, clock) {
  const mapped = mappedFields(section);
  if (!mapped.ok) return failure(verbFailed(mapped.error, CREATE_VERB_ID));
  const present = mapped.value.flatMap((each) => {
    const column = columnNamed(table, each.column);
    return column === void 0 || named2.includes(column.name) ? [] : [{ ...each, column: column.name }];
  });
  if (present.length === 0) return { ok: true, value: [] };
  const client = createJiraClient({ config, fetch: host.fetch });
  const catalogue = await fieldCatalogue(host, client, config, clock.now(), CREATE_VERB_ID);
  if (!catalogue.ok) return failure(verbFailed(catalogue.error, CREATE_VERB_ID));
  const targets = [];
  for (const { column, id } of present) {
    const found = catalogue.value.find((each) => each.id === id);
    if (found === void 0) {
      return failure(
        problem4(`writes the column ${column}, mapped to ${id}, and this site has no such field`)
      );
    }
    const kind = kindOf(found.schema);
    if (kind === void 0) {
      const { type, items } = found.schema;
      return failure(
        problem4(
          `writes the column ${column}, a field of type ${items === void 0 ? type ?? "unknown" : `${type} of ${items}`}, which it cannot write; drop the column before the step`
        )
      );
    }
    targets.push({ column, id, name: column, kind });
  }
  return { ok: true, value: targets };
}
function failure(diagnostic) {
  return { ok: false, error: diagnostic };
}
function cellText(cell) {
  if (cell === void 0 || cell === null) return "";
  return (Array.isArray(cell) ? cell.map(String).join(", ") : textOf(cell)).trim();
}
async function applyCreates(host, request, clock = systemClock) {
  const { operations } = request;
  const session = await openSession(host, request, clock);
  if (!session.ok) return answered(operations.map(() => failedWith(session.error)));
  const { client, finished, expired } = session.value;
  const outcomes = new Array(operations.length);
  const pending = [];
  operations.forEach((operation, index) => {
    const planned = decode4(operation.payload);
    if (typeof planned === "string") outcomes[index] = { status: "failed", reason: planned };
    else pending.push({ index, planned });
  });
  const created = await createdBefore(
    client,
    pending.map(({ planned }) => planned.tok)
  );
  const remaining = pending.filter(({ index, planned }) => {
    if (!created.ok) outcomes[index] = failedWith(created.error);
    const key = created.ok ? created.value.get(planned.tok) : void 0;
    if (key !== void 0) {
      outcomes[index] = { status: "applied", reason: `already created ${key}; nothing written` };
    }
    return outcomes[index] === void 0;
  });
  let refused2;
  for (let start = 0; start < remaining.length; start += BULK_CREATE_SIZE) {
    const chunk = remaining.slice(start, start + BULK_CREATE_SIZE);
    if (refused2 === void 0 && !expired()) {
      const answers = await bulkCreate(
        client,
        chunk.map(({ planned }) => planned)
      );
      chunk.forEach(({ index }, position) => {
        const answer = answers[position] ?? { status: "failed", reason: UNMATCHED };
        outcomes[index] = answer.status === "failed" && answer.reason?.includes(NOT_REACHED) === true ? { status: "skipped", reason: NOT_REACHED } : answer;
        if (answer.reason?.startsWith("E_JIRA_AUTH") === true) refused2 = answer.reason;
      });
      continue;
    }
    for (const { index } of chunk) {
      outcomes[index] = refused2 === void 0 ? { status: "skipped", reason: NOT_REACHED } : { status: "failed", reason: refused2 };
    }
  }
  return answered(outcomes.map(finished));
}
function decode4(payload) {
  const object = record(payload);
  const planned = object?.["x"];
  if (typeof planned === "string") return planned;
  const { p, t, s, d, par, m, tok } = object ?? {};
  const fields = record(m);
  if (typeof p !== "string" || typeof t !== "string" || typeof s !== "string" || typeof tok !== "string" || fields === void 0 || d !== void 0 && typeof d !== "string" || par !== void 0 && typeof par !== "string") {
    return "E_JIRA_PLAN: this operation carries no payload this version of the plugin reads; run the cell again";
  }
  return {
    p,
    t,
    s,
    ...d === void 0 ? {} : { d },
    ...par === void 0 ? {} : { par },
    m: fields,
    tok
  };
}
async function createdBefore(client, labels) {
  const found = /* @__PURE__ */ new Map();
  if (labels.length === 0) return jiraOk(found);
  const wanted = new Set(labels);
  const jql = `labels in (${labels.map((label) => `"${label}"`).join(", ")}) ORDER BY key ASC`;
  let token;
  for (; ; ) {
    const page = await searchPage(client, jql, ["labels"], token);
    if (!page.ok) return page;
    for (const issue of page.value.issues) {
      const carried = issue.fields["labels"];
      for (const label of Array.isArray(carried) ? carried : []) {
        if (typeof label === "string" && wanted.has(label) && !found.has(label)) {
          found.set(label, issue.key);
        }
      }
    }
    const next = page.value.nextPageToken;
    if (page.value.isLast || next === void 0) return jiraOk(found);
    if (next === token) {
      return jiraError(
        "E_JIRA_RESPONSE",
        "the search for the labels answered the token it was given."
      );
    }
    token = next;
  }
}
var UNMATCHED = "E_JIRA_RESPONSE: the bulk create answered what cannot be matched to its rows; run the cell and Apply again, which finds what was created by its label";
async function bulkCreate(client, planned) {
  const answer = await client.post(BULK_CREATE, {
    issueUpdates: planned.map((each) => ({ fields: fieldsOf(each) }))
  });
  let body;
  if (answer.ok) body = record(answer.value);
  else if (answer.error.status === 400) body = record(answer.error.body);
  if (!answer.ok && !Array.isArray(body?.["errors"])) {
    return planned.map(() => failedWith(answer.error));
  }
  const issues = Array.isArray(body?.["issues"]) ? body["issues"] : [];
  const errors = Array.isArray(body?.["errors"]) ? body["errors"] : [];
  const refusals = /* @__PURE__ */ new Map();
  for (const each of errors) {
    const error = record(each);
    const element = error?.["failedElementNumber"];
    if (typeof element !== "number" || !Number.isInteger(element)) continue;
    if (element < 0 || element >= planned.length) continue;
    const status = typeof error?.["status"] === "number" ? ` (${error["status"]})` : "";
    refusals.set(
      element,
      `E_JIRA_HTTP: Jira refused to create it${status}: ${elementMessage(error?.["elementErrors"])}`
    );
  }
  const accepted = planned.flatMap((_, index) => refusals.has(index) ? [] : [index]);
  const keys = issues.map((issue) => record(issue)?.["key"]);
  const matched = keys.length === accepted.length && keys.every((key) => typeof key === "string" && key !== "");
  return planned.map((_, index) => {
    const refusal = refusals.get(index);
    if (refusal !== void 0) return { status: "failed", reason: refusal };
    if (!matched) return { status: "failed", reason: UNMATCHED };
    return { status: "applied", reason: `created ${String(keys[accepted.indexOf(index)])}` };
  });
}
function fieldsOf(planned) {
  const labels = planned.m["labels"];
  return {
    ...planned.m,
    project: { key: planned.p },
    issuetype: { name: planned.t },
    summary: planned.s,
    ...planned.d === void 0 ? {} : { description: textToAdf(planned.d) },
    ...planned.par === void 0 ? {} : { parent: { key: planned.par } },
    labels: [...Array.isArray(labels) ? labels : [], planned.tok]
  };
}
function elementMessage(value) {
  const errors = record(value);
  const messages = [
    ...Array.isArray(errors?.["errorMessages"]) ? errors["errorMessages"].map(String) : [],
    ...Object.entries(record(errors?.["errors"]) ?? {}).map(
      ([field, message]) => `${field}: ${String(message)}`
    )
  ];
  return messages.length === 0 ? "Jira gave no reason" : messages.join("; ");
}
function problem4(text2) {
  return argumentsProblem(text2, CREATE_VERB_ID);
}

// src/refresh.ts
var MAX_KEYS = 1e3;
var MAX_CHILDREN = 5e3;
var BUDGET_MILLISECONDS = 25e3;
var PARENTS_PER_SEARCH = 100;
var ARGUMENTS6 = [
  { name: "by", type: "text" },
  { name: "only", type: "text" },
  { name: "children", type: "boolean" },
  { name: "prefix", type: "text" }
];
var PREFIX = /^[A-Za-z][A-Za-z0-9_]*$/;
var systemClock2 = { now: () => Date.now() };
function refreshVerb(host, clock = systemClock2) {
  return {
    id: REFRESH_VERB_ID,
    kind: "transform",
    arguments: ARGUMENTS6,
    transform: (request) => refreshTable(host, request, clock)
  };
}
async function refreshTable(host, request, clock = systemClock2) {
  const { table } = request;
  const asked = readArguments(request);
  if ("severity" in asked) return refused(asked);
  const { by, only, children, prefix } = asked;
  const mapped = mappedFields(request.section);
  if (!mapped.ok) return refused(verbFailed(mapped.error, REFRESH_VERB_ID));
  const written = (name) => `${prefix}${name}`;
  const jiraNames = new Set(
    [
      ...FIXED_COLUMNS.map((column) => column.name),
      ...mapped.value.map(({ column }) => column)
    ].map((name) => written(name).toLowerCase())
  );
  const writtenKey = written("key").toLowerCase();
  const byName = by?.name.toLowerCase();
  if (byName !== void 0 && byName !== writtenKey && jiraNames.has(byName)) {
    return refused(
      problem5(
        `by= names ${by?.name ?? byName}, a column this verb writes; name key or a column of your own`
      )
    );
  }
  const keyOf = (row) => {
    const value = by === void 0 ? row.key : row.values[by.name];
    const key = typeof value === "string" ? value.trim() : void 0;
    return key !== void 0 && ISSUE_KEY.test(key) ? key : void 0;
  };
  const keys = [
    ...new Set(
      table.rows.filter((row) => only === void 0 || chosenBy(row, only)).map(keyOf).filter((key) => key !== void 0)
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
      else await (clock.sleep ?? wait2)(milliseconds);
    }
  });
  const jiraFailed = (error) => overBudget ? refused(
    narrow(
      `did not finish ${issueCount(keys.length)} within ${BUDGET_MILLISECONDS / 1e3} s`
    )
  ) : refused(verbFailed(error, REFRESH_VERB_ID));
  const types = await mappedTypes(client, mapped.value);
  if (!types.ok) return jiraFailed(types.error);
  const targets = [...FIXED_COLUMNS, ...mappedColumns(mapped.value, types.value)].map((column) => ({
    ...column,
    name: written(column.name)
  }));
  const existing = new Map(table.columns.map((column) => [column.name.toLowerCase(), column]));
  for (const target of targets) {
    const column = existing.get(target.name.toLowerCase());
    if (column !== void 0 && column.type !== target.type) {
      return refused(
        problem5(
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
  const nameOf = (name) => existing.get(name.toLowerCase())?.name ?? name;
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
    for (const [name, value] of Object.entries(row.value.values)) {
      values[nameOf(written(name))] = value;
    }
    live.set(issue.key, {
      key: issue.key,
      values,
      provenance: { source: REFRESH_VERB_ID, id: issue.key, fetchedAt }
    });
  }
  const added = targets.filter((target) => !existing.has(target.name.toLowerCase()));
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
        problem5(
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
    return column ?? problem5(`${name}= names '${String(written)}', which is not a column of the table`);
  };
  const by = columnOf("by");
  if (by !== void 0 && "severity" in by) return by;
  if (by !== void 0 && by.type !== "text") {
    return problem5(`by= names ${by.name}, a ${by.type} column; an issue key is text`);
  }
  const only = columnOf("only");
  if (only !== void 0 && "severity" in only) return only;
  if (only !== void 0 && only.type !== "boolean") {
    return problem5(
      `only= names ${only.name}, a ${only.type} column; name a true or false one, such as recall's mark=`
    );
  }
  const prefix = request.arguments["prefix"];
  if (prefix !== void 0 && !PREFIX.test(String(prefix).trim())) {
    return problem5(
      `prefix= is '${String(prefix)}'; a prefix is letters, digits and underscores, a letter first, such as jira_`
    );
  }
  return {
    by,
    only,
    children: request.arguments["children"] === true,
    prefix: prefix === void 0 ? "" : String(prefix).trim()
  };
}
async function fetchIssues(client, keys, fields) {
  const answered2 = await bulkIssues(client, keys, fields);
  if (!answered2.ok) return answered2;
  const byKey = new Map(answered2.value.issues.map((issue) => [issue.key, issue]));
  const found = /* @__PURE__ */ new Map();
  for (const key of keys) {
    const issue = byKey.get(key);
    if (issue !== void 0) {
      found.set(key, issue);
      continue;
    }
    if (answered2.value.refused.has(key)) continue;
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
function problem5(text2) {
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
var wait2 = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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

// src/write/workflows.ts
function workflowOf(section, name) {
  const written = record(section)?.["workflows"];
  if (written === void 0 || written === null) return jiraOk(void 0);
  const workflows = record(written);
  if (workflows === void 0) {
    return configError2(
      'workflows in the jira section of .tyto/project.json is not an object of workflow names, such as {"delivery": {"To Do": ["In Progress"]}}'
    );
  }
  const entry = Object.entries(workflows).find(([each]) => each === name);
  if (entry === void 0) return jiraOk(void 0);
  const graph = record(entry[1]);
  if (graph === void 0) {
    return configError2(
      `workflow ${name} is not an object of statuses, such as {"To Do": ["In Progress"]}`
    );
  }
  const steps = /* @__PURE__ */ new Map();
  for (const [from, targets] of Object.entries(graph)) {
    if (from.trim() === "" || !Array.isArray(targets) || !targets.every((target) => typeof target === "string" && target.trim() !== "")) {
      return configError2(
        `workflow ${name} maps ${JSON.stringify(from)} to ${JSON.stringify(targets)}; each status maps to a list of status names, such as "To Do": ["In Progress"]`
      );
    }
    const key = from.trim().toLowerCase();
    const known = steps.get(key);
    const next = targets.map((target) => target.trim());
    if (known === void 0) steps.set(key, { name: from.trim(), next });
    else known.next.push(...next);
  }
  return jiraOk({ name, steps });
}
function workflowNames(section) {
  const workflows = record(record(section)?.["workflows"]);
  return workflows === void 0 ? [] : Object.keys(workflows);
}
function shortestPath(workflow, from, to) {
  const start = from.trim().toLowerCase();
  const goal = to.trim().toLowerCase();
  const previous = /* @__PURE__ */ new Map([[start, null]]);
  const names = /* @__PURE__ */ new Map([[start, from.trim()]]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === goal) {
      const path = [];
      for (let at = current; at !== null && at !== start; ) {
        path.unshift(names.get(at) ?? at);
        at = previous.get(at) ?? null;
      }
      return { found: true, path };
    }
    for (const next of workflow.steps.get(current)?.next ?? []) {
      const key = next.toLowerCase();
      if (previous.has(key)) continue;
      previous.set(key, current);
      names.set(key, workflow.steps.get(key)?.name ?? next);
      queue.push(key);
    }
  }
  return {
    found: false,
    reached: [...names.entries()].filter(([key]) => key !== start).map(([, name]) => name)
  };
}
function configError2(message) {
  return jiraError("E_JIRA_CONFIG", message);
}

// src/transition.ts
var TRANSITION_WRITE = "transition";
var ARGUMENTS7 = [
  { name: "to", type: "text" },
  { name: "to-column", type: "text" },
  { name: "workflow", type: "text" },
  { name: "workflow-column", type: "text" },
  { name: "from-column", type: "text" }
];
var REACHED_NAMED = 12;
function transitionVerb(host, clock = systemClock) {
  return {
    id: TRANSITION_VERB_ID,
    kind: "action",
    arguments: ARGUMENTS7,
    writes: [TRANSITION_WRITE],
    plan: (request) => planTransitions(host, request),
    apply: (request) => applyTransitions(host, request, clock)
  };
}
function sourceOf(request, literal, column) {
  const value = request.arguments[literal];
  const named2 = request.arguments[column];
  if (value !== void 0 && named2 !== void 0) {
    return problem6(
      `takes ${literal}= or ${column}=, not both; ${literal}= is one value for every row`
    );
  }
  if (named2 !== void 0) {
    const found = columnNamed(request.table, String(named2).trim());
    if (found === void 0) {
      return problem6(`${column}= names '${String(named2)}', which is not a column of the table`);
    }
    if (found.type !== "text") {
      return problem6(`${column}= names ${found.name}, a ${found.type} column; name a text column`);
    }
    return { kind: "column", column: found.name };
  }
  if (value !== void 0) return { kind: "value", value: String(value).trim() };
  return { kind: "none" };
}
function cellText2(row, column) {
  const value = row.values[column];
  return typeof value === "string" ? value.trim() : "";
}
function missingWorkflow(section, name) {
  const known = workflowNames(section);
  return `workflow=${name}, which the workflows of the jira section of .tyto/project.json ` + (known.length === 0 ? "do not hold; it has none" : `do not hold (${known.join(", ")})`);
}
async function planTransitions(host, request) {
  const { table } = request;
  const target = sourceOf(request, "to", "to-column");
  if ("severity" in target) return planRefused(target);
  if (target.kind === "none" || target.kind === "value" && target.value === "") {
    return planRefused(
      problem6("needs to=, the status to move each issue to, or to-column=, the column holding it")
    );
  }
  const workflowSource = sourceOf(request, "workflow", "workflow-column");
  if ("severity" in workflowSource) return planRefused(workflowSource);
  let fixedWorkflow;
  if (workflowSource.kind === "value") {
    const read = workflowOf(request.section, workflowSource.value);
    if (!read.ok) return planRefused(verbFailed(read.error, TRANSITION_VERB_ID));
    if (read.value === void 0) {
      return planRefused(
        problem6(`names ${missingWorkflow(request.section, workflowSource.value)}`)
      );
    }
    fixedWorkflow = read.value;
  }
  const fromWritten = request.arguments["from-column"];
  const status = columnNamed(table, String(fromWritten ?? "status").trim());
  if (status === void 0) {
    return planRefused(
      fromWritten === void 0 ? problem6("needs the status column jira.pull answers, to know where each issue starts") : problem6(
        `from-column= names '${String(fromWritten)}', which is not a column of the table`
      )
    );
  }
  const config = await resolveJiraConfig(host, request.section);
  if (!config.ok) return planRefused(verbFailed(config.error, TRANSITION_VERB_ID));
  const workflows = /* @__PURE__ */ new Map();
  const operations = [];
  for (const row of table.rows) {
    const to = target.kind === "value" ? target.value : cellText2(row, target.column);
    if (to === "") continue;
    const key = issueKeyOf(row);
    if (key === void 0) {
      operations.push(
        plannedFailure(
          TRANSITION_WRITE,
          row.key,
          `${row.key} \u2192 ${to}`,
          `E_JIRA_PLAN: row ${row.key} names no issue key in its key column or its key`
        )
      );
      continue;
    }
    const from = row.values[status.name];
    if (typeof from !== "string" || from.trim() === "") {
      operations.push(
        plannedFailure(
          TRANSITION_WRITE,
          row.key,
          `${key} \u2192 ${to}`,
          `E_JIRA_PLAN: ${key} has no status in the table`
        )
      );
      continue;
    }
    if (same(from, to)) continue;
    let workflow = fixedWorkflow;
    const workflowName = workflowSource.kind === "column" ? cellText2(row, workflowSource.column) : "";
    if (workflowName !== "") {
      if (!workflows.has(workflowName)) {
        const read = workflowOf(request.section, workflowName);
        if (!read.ok) return planRefused(verbFailed(read.error, TRANSITION_VERB_ID));
        workflows.set(workflowName, read.value);
      }
      workflow = workflows.get(workflowName);
      if (workflow === void 0) {
        operations.push(
          plannedFailure(
            TRANSITION_WRITE,
            row.key,
            `${key}: ${from} \u2192 ${to}`,
            `E_JIRA_CONFIG: ${key} names ${missingWorkflow(request.section, workflowName)}`
          )
        );
        continue;
      }
    }
    let path = [to];
    if (workflow !== void 0) {
      const found = shortestPath(workflow, from, to);
      if (!found.found) {
        operations.push(
          plannedFailure(
            TRANSITION_WRITE,
            row.key,
            `${key}: ${from} \u2192 ${to}`,
            unreachable(workflow.name, from, to, found.reached)
          )
        );
        continue;
      }
      path = found.path;
    }
    const payload = {
      k: key,
      f: from,
      p: path,
      ...workflow === void 0 ? {} : { w: workflow.name }
    };
    operations.push(
      plannedOperation(
        TRANSITION_WRITE,
        row.key,
        `${key}: ${[from, ...path].join(" \u2192 ")}`,
        payload
      )
    );
  }
  return planOf(`Jira ${new URL(config.value.baseUrl).hostname}`, operations);
}
function unreachable(workflow, from, to, reached) {
  const tried = reached.length === 0 ? `${from} has no transition in it` : `the paths tried from ${from} reach only ${reached.slice(0, REACHED_NAMED).join(", ")}` + (reached.length > REACHED_NAMED ? ` and ${reached.length - REACHED_NAMED} more` : "");
  return `E_JIRA_CONFIG: workflow ${workflow} has no path from ${from} to ${to}; ${tried}`;
}
function applyTransitions(host, request, clock = systemClock) {
  return applyBatch(host, request, { decode: decode5, write: walk }, clock);
}
function decode5(payload) {
  const { k, f, p } = payload;
  if (typeof k !== "string" || typeof f !== "string" || !Array.isArray(p) || p.length === 0) {
    return void 0;
  }
  if (!p.every((step) => typeof step === "string")) return void 0;
  return { k, f, p };
}
async function walk(planned, issue, context) {
  const { k: key, f: from, p: path } = planned;
  const target = path[path.length - 1];
  if (same(issue.status, target)) {
    return { status: "applied", reason: `already ${issue.status ?? target}; nothing written` };
  }
  let start;
  if (same(issue.status, from)) {
    start = 0;
  } else {
    const at = path.findIndex((step) => same(step, issue.status));
    if (at < 0) {
      return {
        status: "failed",
        reason: `E_JIRA_MOVED: ${key} moved from ${from} to ${issue.status ?? "no status"} since the plan; run the cell again`
      };
    }
    start = at + 1;
  }
  const walked = [];
  const startedAt = issue.status ?? from;
  const sofar = () => walked.length === 0 ? "" : `; walked ${[startedAt, ...walked].join(" \u2192 ")} before this`;
  for (const step of path.slice(start)) {
    const offered = await transitionsOf(context.client, key);
    if (!offered.ok) return failedWith(offered.error, sofar());
    const matches = offered.value.filter((transition) => same(transition.to, step));
    const only = matches[0];
    if (matches.length !== 1 || only === void 0) {
      const at = issue.status ?? "its status";
      const reason = matches.length === 0 ? `E_JIRA_TRANSITION: ${key} offers no transition from ${at} to ${step}; it offers ` + (offered.value.length === 0 ? "none" : offered.value.map(named).join(", ")) : `E_JIRA_TRANSITION: ${key} offers ${matches.length} transitions from ${at} to ${step}, ${matches.map(named).join(", ")}, and cannot tell which is meant`;
      return { status: "failed", reason: `${reason}${sofar()}` };
    }
    const endpoint = transitionsPath(key);
    const posted = await context.client.post(endpoint, { transition: { id: only.id } });
    if (!posted.ok) return failedWith(posted.error, sofar());
    issue.status = only.to;
    walked.push(only.to);
  }
  const resumed = start === 0 ? "" : ` (resumed at ${startedAt})`;
  return { status: "applied", reason: `walked ${[startedAt, ...walked].join(" \u2192 ")}${resumed}` };
}
function transitionsPath(key) {
  return `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`;
}
async function transitionsOf(client, key) {
  const path = transitionsPath(key);
  const answer = await client.get(path);
  if (!answer.ok) return answer;
  const listed = record(answer.value)?.["transitions"];
  if (!Array.isArray(listed)) {
    return jiraError("E_JIRA_RESPONSE", `GET ${path} answered no transitions list.`);
  }
  const offered = [];
  for (const each of listed) {
    const transition = record(each);
    const id = transition?.["id"];
    const name = transition?.["name"];
    const to = record(transition?.["to"])?.["name"];
    if (typeof id !== "string" || typeof to !== "string") {
      return jiraError(
        "E_JIRA_RESPONSE",
        `GET ${path} answered a transition without an id or a status.`
      );
    }
    offered.push({ id, name: typeof name === "string" ? name : to, to });
  }
  return jiraOk(offered);
}
function named(transition) {
  return `${transition.name} (to ${transition.to})`;
}
function problem6(text2) {
  return argumentsProblem(text2, TRANSITION_VERB_ID);
}

// src/index.ts
function activate(host) {
  const registered = [
    ...SETTINGS.map((setting) => host.registerConfiguration(setting)),
    host.registerRecipeVerb(pullVerb(host)),
    host.registerRecipeVerb(refreshVerb(host)),
    host.registerRecipeVerb(transitionVerb(host)),
    host.registerRecipeVerb(assignVerb(host)),
    host.registerRecipeVerb(setVerb(host)),
    host.registerRecipeVerb(commentVerb(host)),
    host.registerRecipeVerb(createVerb(host))
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
