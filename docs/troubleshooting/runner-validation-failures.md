# Runner Validation Failures

`kspec agent runners validate` reports failures as structured diagnostics with a stable `reason` code. This page describes each code, the symptoms it produces, and how to fix it. Use it as a lookup keyed by the `reason` value that appears in the validator's output or in the JSON `diagnostics` array.

For the full configuration walkthrough, see [Configuring Agent Runners](../guides/configuring-agent-runners.md).

## `unknown_runner`

**Symptom.** An agent references a runner name that is not in the effective registry, or `--runner <name>` was passed to the validator with a name that does not exist.

**What it means.** kspec loaded the project and system layers but did not find a runner with the requested name in either one. The reference points at nothing.

**Recovery.**

1. Run `kspec agent runners validate` with no filter to list every runner kspec did find.
2. Check the spelling in the agent definition (`kspec agent list` shows the `runner` field on each agent).
3. Confirm both config files exist at the resolved paths — the project layer at `.kspec/project.runners.yaml` and the system layer at `<daemon-config-dir>/projects/<project-key>/runners.yaml`.
4. Add the missing runner to one of the layers, or update the agent to reference an existing name.

## `invalid_adapter`

**Symptom.** A runner declares an `adapter` value that is not a registered adapter id.

**What it means.** Runners must point at a registered adapter so kspec knows what to spawn. Schema validation rejects unknown adapter ids at load time.

**Recovery.**

1. Read the diagnostic message — when validation rejects an unknown adapter, the message lists the registered adapter ids kspec is aware of.
2. Edit the runner's `adapter` field in `runners.yaml` to match one of those ids.
3. If you expected an adapter that is not registered, check that the package providing it is installed and the daemon was restarted after install.

## `missing_adapter_registration`

**Symptom.** A runner refers to an adapter that is registered by name but the registration is missing at validation time.

**What it means.** The adapter id passed the load-time check but is no longer in the runtime registry — typically because a plugin or package that registers it has not been loaded into the current process.

**Recovery.**

1. Confirm the package or plugin that registers the adapter is installed.
2. Restart the daemon so plugin initialization runs again.
3. If the adapter is intentionally retired, update the runner to point at a still-registered adapter.

## `unspawnable_command`

**Symptom.** `process.executable` cannot be found, is not executable, or timed out under the validator's quick spawn probe. The diagnostic's details block carries an `unspawnable_reason` (`not_found`, `not_executable`, `timeout`).

**What it means.** The command kspec would spawn for this runner cannot actually be launched. Validation catches this before any agent runs so the failure surfaces in the operator surface rather than inside an invocation.

**Recovery.**

1. Inspect the path in the diagnostic message.
2. Confirm the file exists, is a regular file, and has the executable bit set for the user that will run the daemon.
3. If the path was relative, make it absolute or resolve it against the daemon's working directory.
4. If the runner does not need an executable override, remove `process.executable` so the adapter's registered command is used (`command_source` becomes `adapter`).

## `invalid_cwd`

**Symptom.** `process.cwd` does not exist, is not a directory, or is not accessible. The details block carries a more specific `invalid_cwd_reason` (`not_found`, `not_directory`, `not_accessible`).

**What it means.** The validator checked the directory before spawn and could not confirm it is usable as a child-process working directory.

**Recovery.**

1. Create the directory or fix its permissions.
2. If the path is incorrect, edit the runner's `process.cwd` field.
3. If you do not need a cwd override, remove the field — the invocation cwd will be used (`cwd_source` becomes `invocation`).

## `invalid_args`

**Symptom.** `process.args` contains a value that looks like a secret: a `Bearer <token>` string, a `--api-key=…` argument, the value that follows a credential-named flag, or any pattern the secret-shape detector matches.

**What it means.** Credentials must come through `env.secrets` bindings — they are never accepted in process args because args are visible in process listings and ACP diagnostics.

**Recovery.**

1. Identify the flagged arg index from the diagnostic message.
2. Remove the credential from `process.args`.
3. Bind the credential under `env.secrets` in the system layer (e.g., `MY_TOKEN: { source: user_env, required: true }`).
4. Configure the adapter or executable to read the credential from the env var instead of an argument.

## `missing_secret`

**Symptom.** A `required: true` `env.secrets` binding could not be resolved from its source when an invocation prepared.

**What it means.** The runner declared the credential as required but the source (e.g., `user_env`) does not contain a value for it. The invocation is blocked before adapter spawn so no prompt content reaches the child process.

**Recovery.**

1. Set the missing variable in the credential source (for `user_env`, that is the user's process environment).
2. If the credential is genuinely optional, change `required: true` to `required: false` (or omit it — `false` is the default).
3. If the binding is no longer needed, remove the `env.secrets` entry.

## `invalid_command_reference`

**Symptom.** The validator could not resolve `process.executable` to a command reference at all — typically because the value is empty, malformed, or fails earlier than the spawn probe.

**What it means.** The configured executable shape is wrong before kspec even tries to launch it.

**Recovery.**

1. Confirm the value is a non-empty string in `runners.yaml`.
2. Replace any shell-style expressions (`~/bin/foo`, `$HOME/foo`) with absolute paths — runner config does not expand shell syntax.
3. If the field was meant to be omitted, delete it entirely so the adapter's registered command is used.

## `preflight_failure`

**Symptom.** A generic preflight error during validation. Common variants include YAML parse errors in either layer file, schema-level rejections (such as a project-layer file that declares `env.secrets`), or unexpected I/O errors when reading the config.

**What it means.** Validation could not get far enough to evaluate individual runner fields because the config layer itself is unhealthy.

**Recovery.**

1. Read the diagnostic `message` and `details` — they name the file path and the specific failure.
2. For YAML parse errors, open the file in an editor and fix the syntax.
3. For schema rejections, check the field listed in the message against the rules in [Configuring Agent Runners](../guides/configuring-agent-runners.md):
   - `env.secrets` is system-only.
   - `env.set` rejects secret-looking keys and known credential variable names.
   - `process.args` rejects secret-shaped values.
   - `kind` must be a supported value (currently `acp_process`).
   - `adapter` must reference a registered adapter id.
4. Re-run `kspec agent runners validate` to confirm the file loads cleanly.

## Report-Level Issues

Some failures are not scoped to a single runner and appear in the top-level `issues` array in the JSON payload (or under "Configuration issues" in human-readable output). Common cases:

- **Layer YAML parse errors** — surfaced as `preflight_failure` issues with the offending file path.
- **Unknown runner filter** — passing `--runner <name>` with a name that does not exist surfaces as `unknown_runner` at the report level.
- **Schema validation of either layer** — fields rejected by the project- or system-layer schema produce report-level issues with the field path the schema flagged.

A report with any report-level issue exits non-zero even if every individual runner that did load is valid. Fix report-level issues first; per-runner diagnostics may resolve on their own once the layer files load cleanly.
