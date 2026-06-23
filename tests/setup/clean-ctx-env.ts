delete process.env.CORTEXTOS_DIR;
delete process.env.CTX_AGENT_DIR;
delete process.env.CTX_PROJECT_ROOT;
delete process.env.CTX_FRAMEWORK_ROOT;

// Strip credentials inherited from daemon-spawned agent sessions.
// When the daemon launches Claude Code as an agent, it injects org secrets
// (APPFOLIO_PASSWORD, API keys, bot tokens, etc.) into the child process env.
// Any test suite run inside that session inherits those secrets. Sanitize here
// so failing tests cannot leak credentials in their diff output.
const SENSITIVE_KEY_PATTERN = /PASSWORD|API_KEY|TOKEN|SECRET|BOT_TOKEN|CHAT_ID|KEY_FILE|GMAIL|IMAP|OAUTH/i;
for (const key of Object.keys(process.env)) {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    delete process.env[key];
  }
}
