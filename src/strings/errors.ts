/**
 * Centralized error messages for CLI commands
 *
 * Organizes error messages by category to improve maintainability and consistency.
 * Each category corresponds to a common error pattern across command files.
 */

import chalk from 'chalk';

/**
 * Reference resolution errors (not found, ambiguous, wrong type)
 */
export const referenceErrors = {
  // Not found
  itemNotFound: (ref: string) => `Item not found: ${ref}`,
  taskNotFound: (ref: string) => `Task not found: ${ref}`,
  specNotFound: (ref: string) => `Spec item not found: ${ref}`,
  metaNotFound: (ref: string) => `Meta item not found: ${ref}`,
  inboxNotFound: (ref: string) => `Inbox item not found: ${ref}`,
  observationNotFound: (ref: string) => `Observation not found: ${ref}`,
  depNotFound: (ref: string) => `Dependency reference not found: ${ref}`,
  acNotFound: (acId: string, itemRef: string) =>
    `Acceptance criterion "${acId}" not found on @${itemRef}`,

  // Ambiguous references
  ambiguous: (ref: string) => `Reference "${ref}" is ambiguous. Matches:`,
  slugMapsToMultiple: (ref: string) => `Slug "${ref}" maps to multiple items. Use ULID instead:`,

  // Wrong type
  notTask: (ref: string) => `Reference "${ref}" is not a task (it's a spec item)`,
  notItem: (ref: string) => `"${ref}" is a task, not a spec item. Use 'kspec task get' instead.`,
  taskUseTaskCommands: (ref: string) => `"${ref}" is a task. Use 'kspec task' commands instead.`,
  itemUseTaskCancel: (ref: string) => `"${ref}" is a task. Use 'kspec task cancel' instead.`,
  parentIsTask: (ref: string) => `"${ref}" is a task. Items can only be added under spec items.`,
  notSpecItem: (ref: string) => `Reference "${ref}" is a task, not a spec item. Derive only works on spec items.`,

  // Meta reference errors
  metaRefNotFound: (ref: string) => `meta_ref '${ref}' does not resolve to a valid meta item (agent, workflow, or convention)`,
  metaRefPointsToSpec: (ref: string) => `meta_ref '${ref}' points to a spec item; use --spec-ref for product spec references`,
  metaRefNotFound2: (ref: string) => `meta_ref '${ref}' not found`,

  // Spec reference errors
  specRefNotFound: (ref: string) => `Spec reference not found: ${ref}`,
  specRefIsTask: (ref: string) => `Reference "${ref}" is a task, not a spec item`,

  // Reference not found (generic)
  refNotFound: (ref: string) => `Reference not found: ${ref}`,
} as const;

/**
 * Slug validation errors
 */
export const slugErrors = {
  alreadyExists: (slug: string, existingUlid: string) =>
    `Slug '${slug}' already exists (used by ${existingUlid})`,
  notFound: (slug: string) => `Slug '${slug}' not found on item`,
  cannotRemoveLast: (slug: string) =>
    `Cannot remove last slug '${slug}' - items must have at least one slug`,
} as const;

/**
 * Validation errors (JSON, data format, constraints)
 */
export const validationErrors = {
  // JSON parsing
  invalidJson: 'Invalid JSON syntax',
  invalidJsonInData: (err: string) => `Invalid JSON in --data${err ? `: ${err}` : ''}`,
  invalidJsonFromStdin: (err: string) => `Invalid JSON from stdin${err ? `: ${err}` : ''}`,
  invalidPatchData: (err: string) => `Invalid patch data${err ? `: ${err}` : ''}`,

  // Data validation
  noPatchesProvided: 'No patches provided',
  noPatchData: 'No patch data. Use --data or pipe JSON to stdin.',
  noInputProvided: 'No input provided. Use --data for single item or pipe JSONL/JSON for bulk.',
  failedToParseBulk: (err: string) => `Failed to parse bulk input${err ? `: ${err}` : ''}`,

  // Field validation
  unknownFields: (fields: string[]) => `Unknown field(s): ${fields.join(', ')}`,
  invalidPatchDataWithIssues: (issues: string) => `Invalid patch data: ${issues}`,

  // Constraint validation
  priorityOutOfRange: 'Priority must be between 1 and 5',
  invalidObservationType: (type: string) => `Invalid observation type: ${type}`,
  invalidType: (type: string, validTypes: string[]) =>
    `Invalid type: ${type}. Must be one of: ${validTypes.join(', ')}`,
  invalidTodoId: (id: string) => `Invalid todo ID: ${id}`,

  // Required fields
  titleRequired: 'Task title is required',
  resolutionRequired: 'Resolution text is required',
  agentRequiresId: 'Agent requires --id',
  agentRequiresName: 'Agent requires --name',
  workflowRequiresId: 'Workflow requires --id',
  workflowRequiresTrigger: 'Workflow requires --trigger',
  conventionRequiresDomain: 'Convention requires --domain',
} as const;

/**
 * Status/state errors (wrong status for operation)
 */
export const statusErrors = {
  cannotStart: (status: string) => `Cannot start task with status: ${status}`,
  cannotComplete: (status: string) => `Cannot complete task with status: ${status}`,
  cannotBlock: (status: string) => `Cannot block task with status: ${status}`,
} as const;

/**
 * Duplicate/conflict errors
 */
export const conflictErrors = {
  acAlreadyExists: (acId: string, itemRef: string) =>
    `Acceptance criterion "${acId}" already exists on @${itemRef}`,
  acIdAlreadyExists: (acId: string) => `Acceptance criterion "${acId}" already exists`,
  observationAlreadyPromoted: (taskRef: string) =>
    `Observation already promoted to task ${taskRef}; resolve or delete the task first`,
  observationAlreadyResolved: (date: string, reason: string) =>
    `Observation already resolved on ${date}: '${reason}'`,
  specDirExists: (dir: string) => `spec/ directory already exists in ${dir}`,
} as const;

/**
 * Operation not allowed errors
 */
export const operationErrors = {
  cannotDeleteNoSource: 'Cannot delete item: no source file tracked',
  cannotPromoteResolved: 'Cannot promote resolved observation; use --force to override',
  tasksNoAcceptanceCriteria: (ref: string) =>
    `Tasks don't have acceptance criteria; "${ref}" is a task`,
  confirmRequired: (itemLabel: string) =>
    `Warning: This will delete ${itemLabel}. Use --confirm to skip this prompt`,
} as const;

/**
 * Git-related errors
 */
export const gitErrors = {
  notGitRepo: 'Not a git repository',
  couldNotDetermineRoot: 'Could not determine git root directory',
} as const;

/**
 * Project/initialization errors
 */
export const projectErrors = {
  noKspecProject: 'No kspec project found',
  shadowInitFailed: (error: string) => `Shadow initialization failed: ${error}`,
  couldNotGetImplSummary: 'Could not get implementation summary',
} as const;

/**
 * Usage/argument errors
 */
export const usageErrors = {
  // Derive command
  deriveNeedRefOrAll: 'Either provide a spec reference or use --all',
  deriveCannotUseBoth: 'Cannot use both a specific reference and --all',
  deriveUsageHelp: {
    header: 'Usage:',
    examples: [
      '  kspec derive @spec-ref',
      '  kspec derive @spec-ref --flat',
      '  kspec derive --all',
    ],
  },

  // Patch command
  patchNeedRef: 'Reference required for single item patch. Use: kspec item patch <ref> --data <json>',

  // Log command
  logNeedRef: 'Provide a reference or use --spec/--task',

  // Ralph command
  maxLoopsPositive: '--max-loops must be a positive integer',
  maxRetriesNonNegative: '--max-retries must be a non-negative integer',
  maxFailuresPositive: '--max-failures must be a positive integer',
  agentPromptCancelled: 'Agent prompt was cancelled',
} as const;

/**
 * Generic operation failures (with err object)
 */
export const operationFailures = {
  // Item operations
  listItems: 'Failed to list items',
  getItem: 'Failed to get item',
  createItem: 'Failed to create item',
  updateItem: 'Failed to update item',
  deleteItem: 'Failed to delete item',
  patchItems: 'Failed to patch item(s)',
  getItemStatus: 'Failed to get item status',
  getTypes: 'Failed to get types',
  getTags: 'Failed to get tags',
  listAc: 'Failed to list acceptance criteria',
  addAc: 'Failed to add acceptance criterion',
  updateAc: 'Failed to update acceptance criterion',
  removeAc: 'Failed to remove acceptance criterion',

  // Task operations
  getTask: 'Failed to get task',
  createTask: 'Failed to create task',
  updateTask: 'Failed to update task',
  patchTask: 'Failed to patch task',
  startTask: 'Failed to start task',
  completeTask: 'Failed to complete task',
  blockTask: 'Failed to block task',
  unblockTask: 'Failed to unblock task',
  cancelTask: 'Failed to cancel task',
  deleteTask: 'Failed to delete task',
  addNote: 'Failed to add note',
  getNotes: 'Failed to get notes',
  getTodos: 'Failed to get todos',
  addTodo: 'Failed to add todo',
  markTodoDone: 'Failed to mark todo as done',
  markTodoNotDone: 'Failed to mark todo as not done',
  listTasks: 'Failed to list tasks',
  getReadyTasks: 'Failed to get ready tasks',
  getNextTask: 'Failed to get next task',
  getBlockedTasks: 'Failed to get blocked tasks',
  getActiveTasks: 'Failed to get active tasks',

  // Meta operations
  showMeta: 'Failed to show meta',
  listAgents: 'Failed to list agents',
  listWorkflows: 'Failed to list workflows',
  listConventions: 'Failed to list conventions',
  getMetaItem: 'Failed to get meta item',
  listMetaItems: 'Failed to list meta items',
  createObservation: 'Failed to create observation',
  listObservations: 'Failed to list observations',
  promoteObservation: 'Failed to promote observation',
  resolveObservation: 'Failed to resolve observation',
  createMeta: (type: string) => `Failed to create ${type}`,
  updateMetaItem: 'Failed to update meta item',
  deleteMetaItem: 'Failed to delete meta item',

  // Inbox operations
  addInboxItem: 'Failed to add inbox item',
  listInboxItems: 'Failed to list inbox items',
  promoteInboxItem: 'Failed to promote inbox item',
  deleteInboxItem: 'Failed to delete inbox item',
  getInboxItem: 'Failed to get inbox item',

  // Session operations
  gatherSessionContext: 'Failed to gather session context',
  runCheckpoint: 'Failed to run checkpoint',

  // Search operations
  search: 'Failed to search',
  searchCommits: 'Failed to search commits',

  // Init operations
  initProject: 'Failed to initialize project',

  // Setup operations
  installConfig: (agentType: string) => `Failed to install config for ${agentType}`,
  setupFailed: 'Setup failed',

  // Derive operations
  deriveTasks: 'Failed to derive tasks',

  // Ralph operations
  ralphLoop: 'Ralph loop failed',
  iterationFailed: (err: string) => `Iteration failed: ${err}`,
  iterationFailedAfterRetries: (iteration: number, maxRetries: number, consecutiveFailures: number, maxFailures: number) =>
    `Iteration ${iteration} failed after ${maxRetries + 1} attempts (${consecutiveFailures}/${maxFailures} consecutive failures)`,
  lastError: (err: string) => `Last error: ${err}`,
  reachedMaxFailures: (maxFailures: number) =>
    `Reached ${maxFailures} consecutive failures. Exiting loop.`,
} as const;

/**
 * Todo-specific errors
 */
export const todoErrors = {
  notFound: (id: number) => `Todo #${id} not found`,
  invalidId: (id: string) => `Invalid todo ID: ${id}`,
} as const;

/**
 * Re-export all error categories as a single object for convenience
 */
export const errors = {
  reference: referenceErrors,
  slug: slugErrors,
  validation: validationErrors,
  status: statusErrors,
  conflict: conflictErrors,
  operation: operationErrors,
  git: gitErrors,
  project: projectErrors,
  usage: usageErrors,
  failures: operationFailures,
  todo: todoErrors,
} as const;
