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
  const registered = SETTINGS.map((setting) => host.registerConfiguration(setting));
  return {
    dispose() {
      for (const registration of registered) registration.dispose();
    }
  };
}
export {
  activate
};
