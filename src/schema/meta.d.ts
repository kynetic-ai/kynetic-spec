import { z } from "zod";
/**
 * Agent session protocol - commands to run at session lifecycle events
 */
export declare const SessionProtocolSchema: z.ZodObject<{
    start: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    checkpoint: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    end: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    start?: string | null | undefined;
    checkpoint?: string | null | undefined;
    end?: string | null | undefined;
}, {
    start?: string | null | undefined;
    checkpoint?: string | null | undefined;
    end?: string | null | undefined;
}>;
/**
 * Agent definition - describes an agent's role and capabilities
 */
export declare const AgentSchema: z.ZodObject<{
    _ulid: z.ZodString;
    id: z.ZodString;
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    capabilities: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    tools: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    session_protocol: z.ZodOptional<z.ZodObject<{
        start: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        checkpoint: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        end: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        start?: string | null | undefined;
        checkpoint?: string | null | undefined;
        end?: string | null | undefined;
    }, {
        start?: string | null | undefined;
        checkpoint?: string | null | undefined;
        end?: string | null | undefined;
    }>>;
    conventions: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    _ulid: string;
    id: string;
    name: string;
    capabilities: string[];
    tools: string[];
    conventions: string[];
    description?: string | undefined;
    session_protocol?: {
        start?: string | null | undefined;
        checkpoint?: string | null | undefined;
        end?: string | null | undefined;
    } | undefined;
}, {
    _ulid: string;
    id: string;
    name: string;
    description?: string | undefined;
    capabilities?: string[] | undefined;
    tools?: string[] | undefined;
    session_protocol?: {
        start?: string | null | undefined;
        checkpoint?: string | null | undefined;
        end?: string | null | undefined;
    } | undefined;
    conventions?: string[] | undefined;
}>;
/**
 * Workflow step types
 */
export declare const WorkflowStepTypeSchema: z.ZodEnum<["check", "action", "decision"]>;
/**
 * Workflow step execution hints
 */
export declare const StepExecutionSchema: z.ZodObject<{
    mode: z.ZodDefault<z.ZodEnum<["prompt", "silent", "skip"]>>;
    timeout: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
}, "strip", z.ZodTypeAny, {
    mode: "prompt" | "silent" | "skip";
    timeout?: number | null | undefined;
}, {
    mode?: "prompt" | "silent" | "skip" | undefined;
    timeout?: number | null | undefined;
}>;
/**
 * Workflow step input definition
 */
export declare const StepInputSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    required: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
    type: z.ZodOptional<z.ZodDefault<z.ZodEnum<["string", "ref", "number"]>>>;
}, "strip", z.ZodTypeAny, {
    name: string;
    type?: "string" | "number" | "ref" | undefined;
    description?: string | undefined;
    required?: boolean | undefined;
}, {
    name: string;
    type?: "string" | "number" | "ref" | undefined;
    description?: string | undefined;
    required?: boolean | undefined;
}>;
/**
 * Workflow step - a single step in a workflow
 */
export declare const WorkflowStepSchema: z.ZodObject<{
    type: z.ZodEnum<["check", "action", "decision"]>;
    content: z.ZodString;
    on_fail: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    execution: z.ZodOptional<z.ZodObject<{
        mode: z.ZodDefault<z.ZodEnum<["prompt", "silent", "skip"]>>;
        timeout: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    }, "strip", z.ZodTypeAny, {
        mode: "prompt" | "silent" | "skip";
        timeout?: number | null | undefined;
    }, {
        mode?: "prompt" | "silent" | "skip" | undefined;
        timeout?: number | null | undefined;
    }>>;
    entry_criteria: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    exit_criteria: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    inputs: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        required: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
        type: z.ZodOptional<z.ZodDefault<z.ZodEnum<["string", "ref", "number"]>>>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        type?: "string" | "number" | "ref" | undefined;
        description?: string | undefined;
        required?: boolean | undefined;
    }, {
        name: string;
        type?: "string" | "number" | "ref" | undefined;
        description?: string | undefined;
        required?: boolean | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    type: "action" | "check" | "decision";
    content: string;
    options?: string[] | undefined;
    on_fail?: string | undefined;
    execution?: {
        mode: "prompt" | "silent" | "skip";
        timeout?: number | null | undefined;
    } | undefined;
    entry_criteria?: string[] | undefined;
    exit_criteria?: string[] | undefined;
    inputs?: {
        name: string;
        type?: "string" | "number" | "ref" | undefined;
        description?: string | undefined;
        required?: boolean | undefined;
    }[] | undefined;
}, {
    type: "action" | "check" | "decision";
    content: string;
    options?: string[] | undefined;
    on_fail?: string | undefined;
    execution?: {
        mode?: "prompt" | "silent" | "skip" | undefined;
        timeout?: number | null | undefined;
    } | undefined;
    entry_criteria?: string[] | undefined;
    exit_criteria?: string[] | undefined;
    inputs?: {
        name: string;
        type?: "string" | "number" | "ref" | undefined;
        description?: string | undefined;
        required?: boolean | undefined;
    }[] | undefined;
}>;
/**
 * Workflow definition - structured process definition
 */
export declare const WorkflowSchema: z.ZodObject<{
    _ulid: z.ZodString;
    id: z.ZodString;
    trigger: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    steps: z.ZodDefault<z.ZodArray<z.ZodObject<{
        type: z.ZodEnum<["check", "action", "decision"]>;
        content: z.ZodString;
        on_fail: z.ZodOptional<z.ZodString>;
        options: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        execution: z.ZodOptional<z.ZodObject<{
            mode: z.ZodDefault<z.ZodEnum<["prompt", "silent", "skip"]>>;
            timeout: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        }, "strip", z.ZodTypeAny, {
            mode: "prompt" | "silent" | "skip";
            timeout?: number | null | undefined;
        }, {
            mode?: "prompt" | "silent" | "skip" | undefined;
            timeout?: number | null | undefined;
        }>>;
        entry_criteria: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        exit_criteria: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        inputs: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            required: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
            type: z.ZodOptional<z.ZodDefault<z.ZodEnum<["string", "ref", "number"]>>>;
        }, "strip", z.ZodTypeAny, {
            name: string;
            type?: "string" | "number" | "ref" | undefined;
            description?: string | undefined;
            required?: boolean | undefined;
        }, {
            name: string;
            type?: "string" | "number" | "ref" | undefined;
            description?: string | undefined;
            required?: boolean | undefined;
        }>, "many">>;
    }, "strip", z.ZodTypeAny, {
        type: "action" | "check" | "decision";
        content: string;
        options?: string[] | undefined;
        on_fail?: string | undefined;
        execution?: {
            mode: "prompt" | "silent" | "skip";
            timeout?: number | null | undefined;
        } | undefined;
        entry_criteria?: string[] | undefined;
        exit_criteria?: string[] | undefined;
        inputs?: {
            name: string;
            type?: "string" | "number" | "ref" | undefined;
            description?: string | undefined;
            required?: boolean | undefined;
        }[] | undefined;
    }, {
        type: "action" | "check" | "decision";
        content: string;
        options?: string[] | undefined;
        on_fail?: string | undefined;
        execution?: {
            mode?: "prompt" | "silent" | "skip" | undefined;
            timeout?: number | null | undefined;
        } | undefined;
        entry_criteria?: string[] | undefined;
        exit_criteria?: string[] | undefined;
        inputs?: {
            name: string;
            type?: "string" | "number" | "ref" | undefined;
            description?: string | undefined;
            required?: boolean | undefined;
        }[] | undefined;
    }>, "many">>;
    enforcement: z.ZodOptional<z.ZodDefault<z.ZodEnum<["advisory", "strict"]>>>;
}, "strip", z.ZodTypeAny, {
    _ulid: string;
    id: string;
    trigger: string;
    steps: {
        type: "action" | "check" | "decision";
        content: string;
        options?: string[] | undefined;
        on_fail?: string | undefined;
        execution?: {
            mode: "prompt" | "silent" | "skip";
            timeout?: number | null | undefined;
        } | undefined;
        entry_criteria?: string[] | undefined;
        exit_criteria?: string[] | undefined;
        inputs?: {
            name: string;
            type?: "string" | "number" | "ref" | undefined;
            description?: string | undefined;
            required?: boolean | undefined;
        }[] | undefined;
    }[];
    description?: string | undefined;
    enforcement?: "advisory" | "strict" | undefined;
}, {
    _ulid: string;
    id: string;
    trigger: string;
    description?: string | undefined;
    steps?: {
        type: "action" | "check" | "decision";
        content: string;
        options?: string[] | undefined;
        on_fail?: string | undefined;
        execution?: {
            mode?: "prompt" | "silent" | "skip" | undefined;
            timeout?: number | null | undefined;
        } | undefined;
        entry_criteria?: string[] | undefined;
        exit_criteria?: string[] | undefined;
        inputs?: {
            name: string;
            type?: "string" | "number" | "ref" | undefined;
            description?: string | undefined;
            required?: boolean | undefined;
        }[] | undefined;
    }[] | undefined;
    enforcement?: "advisory" | "strict" | undefined;
}>;
/**
 * Convention example (good/bad)
 */
export declare const ConventionExampleSchema: z.ZodObject<{
    good: z.ZodString;
    bad: z.ZodString;
}, "strip", z.ZodTypeAny, {
    good: string;
    bad: string;
}, {
    good: string;
    bad: string;
}>;
/**
 * Convention validation configuration
 */
export declare const ConventionValidationSchema: z.ZodObject<{
    type: z.ZodEnum<["regex", "enum", "range", "prose"]>;
    pattern: z.ZodOptional<z.ZodString>;
    message: z.ZodOptional<z.ZodString>;
    allowed: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    min: z.ZodOptional<z.ZodNumber>;
    max: z.ZodOptional<z.ZodNumber>;
    unit: z.ZodOptional<z.ZodEnum<["words", "chars", "lines"]>>;
}, "strip", z.ZodTypeAny, {
    type: "regex" | "enum" | "range" | "prose";
    message?: string | undefined;
    pattern?: string | undefined;
    allowed?: string[] | undefined;
    min?: number | undefined;
    max?: number | undefined;
    unit?: "lines" | "words" | "chars" | undefined;
}, {
    type: "regex" | "enum" | "range" | "prose";
    message?: string | undefined;
    pattern?: string | undefined;
    allowed?: string[] | undefined;
    min?: number | undefined;
    max?: number | undefined;
    unit?: "lines" | "words" | "chars" | undefined;
}>;
/**
 * Convention definition - project-specific rules and standards
 */
export declare const ConventionSchema: z.ZodObject<{
    _ulid: z.ZodString;
    domain: z.ZodString;
    rules: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    examples: z.ZodDefault<z.ZodArray<z.ZodObject<{
        good: z.ZodString;
        bad: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        good: string;
        bad: string;
    }, {
        good: string;
        bad: string;
    }>, "many">>;
    validation: z.ZodOptional<z.ZodObject<{
        type: z.ZodEnum<["regex", "enum", "range", "prose"]>;
        pattern: z.ZodOptional<z.ZodString>;
        message: z.ZodOptional<z.ZodString>;
        allowed: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        min: z.ZodOptional<z.ZodNumber>;
        max: z.ZodOptional<z.ZodNumber>;
        unit: z.ZodOptional<z.ZodEnum<["words", "chars", "lines"]>>;
    }, "strip", z.ZodTypeAny, {
        type: "regex" | "enum" | "range" | "prose";
        message?: string | undefined;
        pattern?: string | undefined;
        allowed?: string[] | undefined;
        min?: number | undefined;
        max?: number | undefined;
        unit?: "lines" | "words" | "chars" | undefined;
    }, {
        type: "regex" | "enum" | "range" | "prose";
        message?: string | undefined;
        pattern?: string | undefined;
        allowed?: string[] | undefined;
        min?: number | undefined;
        max?: number | undefined;
        unit?: "lines" | "words" | "chars" | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    _ulid: string;
    domain: string;
    rules: string[];
    examples: {
        good: string;
        bad: string;
    }[];
    validation?: {
        type: "regex" | "enum" | "range" | "prose";
        message?: string | undefined;
        pattern?: string | undefined;
        allowed?: string[] | undefined;
        min?: number | undefined;
        max?: number | undefined;
        unit?: "lines" | "words" | "chars" | undefined;
    } | undefined;
}, {
    _ulid: string;
    domain: string;
    validation?: {
        type: "regex" | "enum" | "range" | "prose";
        message?: string | undefined;
        pattern?: string | undefined;
        allowed?: string[] | undefined;
        min?: number | undefined;
        max?: number | undefined;
        unit?: "lines" | "words" | "chars" | undefined;
    } | undefined;
    rules?: string[] | undefined;
    examples?: {
        good: string;
        bad: string;
    }[] | undefined;
}>;
/**
 * Observation types
 */
export declare const ObservationTypeSchema: z.ZodEnum<["friction", "success", "question", "idea"]>;
/**
 * Observation - feedback about workflows and conventions
 */
export declare const ObservationSchema: z.ZodObject<{
    _ulid: z.ZodString;
    type: z.ZodEnum<["friction", "success", "question", "idea"]>;
    workflow_ref: z.ZodOptional<z.ZodString>;
    content: z.ZodString;
    created_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
    author: z.ZodOptional<z.ZodString>;
    resolved: z.ZodDefault<z.ZodBoolean>;
    resolution: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    resolved_at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>;
    resolved_by: z.ZodOptional<z.ZodString>;
    promoted_to: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "friction" | "success" | "question" | "idea";
    _ulid: string;
    created_at: string;
    content: string;
    resolved: boolean;
    author?: string | undefined;
    promoted_to?: string | undefined;
    workflow_ref?: string | undefined;
    resolution?: string | null | undefined;
    resolved_at?: string | undefined;
    resolved_by?: string | undefined;
}, {
    type: "friction" | "success" | "question" | "idea";
    _ulid: string;
    created_at: string;
    content: string;
    author?: string | undefined;
    promoted_to?: string | undefined;
    workflow_ref?: string | undefined;
    resolved?: boolean | undefined;
    resolution?: string | null | undefined;
    resolved_at?: string | undefined;
    resolved_by?: string | undefined;
}>;
/**
 * Session context schema - ephemeral session state
 */
export declare const SessionContextSchema: z.ZodObject<{
    focus: z.ZodNullable<z.ZodString>;
    threads: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    open_questions: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    updated_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
}, "strip", z.ZodTypeAny, {
    focus: string | null;
    threads: string[];
    open_questions: string[];
    updated_at: string;
}, {
    focus: string | null;
    updated_at: string;
    threads?: string[] | undefined;
    open_questions?: string[] | undefined;
}>;
/**
 * Step result status
 */
export declare const StepResultStatusSchema: z.ZodEnum<["completed", "skipped", "failed"]>;
/**
 * Step result schema - result of executing a workflow step
 */
export declare const StepResultSchema: z.ZodObject<{
    step_index: z.ZodNumber;
    status: z.ZodEnum<["completed", "skipped", "failed"]>;
    started_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
    completed_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
    entry_confirmed: z.ZodOptional<z.ZodBoolean>;
    exit_confirmed: z.ZodOptional<z.ZodBoolean>;
    notes: z.ZodOptional<z.ZodString>;
    inputs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    status: "completed" | "skipped" | "failed";
    started_at: string;
    completed_at: string;
    step_index: number;
    notes?: string | undefined;
    inputs?: Record<string, string> | undefined;
    entry_confirmed?: boolean | undefined;
    exit_confirmed?: boolean | undefined;
}, {
    status: "completed" | "skipped" | "failed";
    started_at: string;
    completed_at: string;
    step_index: number;
    notes?: string | undefined;
    inputs?: Record<string, string> | undefined;
    entry_confirmed?: boolean | undefined;
    exit_confirmed?: boolean | undefined;
}>;
/**
 * Workflow run status
 */
export declare const WorkflowRunStatusSchema: z.ZodEnum<["active", "paused", "completed", "aborted"]>;
/**
 * Workflow run schema - tracks execution of a workflow
 */
export declare const WorkflowRunSchema: z.ZodObject<{
    _ulid: z.ZodString;
    workflow_ref: z.ZodString;
    status: z.ZodEnum<["active", "paused", "completed", "aborted"]>;
    current_step: z.ZodNumber;
    total_steps: z.ZodNumber;
    started_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
    paused_at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>;
    completed_at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>;
    step_results: z.ZodDefault<z.ZodArray<z.ZodObject<{
        step_index: z.ZodNumber;
        status: z.ZodEnum<["completed", "skipped", "failed"]>;
        started_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
        completed_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
        entry_confirmed: z.ZodOptional<z.ZodBoolean>;
        exit_confirmed: z.ZodOptional<z.ZodBoolean>;
        notes: z.ZodOptional<z.ZodString>;
        inputs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        status: "completed" | "skipped" | "failed";
        started_at: string;
        completed_at: string;
        step_index: number;
        notes?: string | undefined;
        inputs?: Record<string, string> | undefined;
        entry_confirmed?: boolean | undefined;
        exit_confirmed?: boolean | undefined;
    }, {
        status: "completed" | "skipped" | "failed";
        started_at: string;
        completed_at: string;
        step_index: number;
        notes?: string | undefined;
        inputs?: Record<string, string> | undefined;
        entry_confirmed?: boolean | undefined;
        exit_confirmed?: boolean | undefined;
    }>, "many">>;
    initiated_by: z.ZodOptional<z.ZodString>;
    abort_reason: z.ZodOptional<z.ZodString>;
    task_ref: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "completed" | "aborted" | "active" | "paused";
    _ulid: string;
    started_at: string;
    workflow_ref: string;
    current_step: number;
    total_steps: number;
    step_results: {
        status: "completed" | "skipped" | "failed";
        started_at: string;
        completed_at: string;
        step_index: number;
        notes?: string | undefined;
        inputs?: Record<string, string> | undefined;
        entry_confirmed?: boolean | undefined;
        exit_confirmed?: boolean | undefined;
    }[];
    completed_at?: string | undefined;
    paused_at?: string | undefined;
    initiated_by?: string | undefined;
    abort_reason?: string | undefined;
    task_ref?: string | undefined;
}, {
    status: "completed" | "aborted" | "active" | "paused";
    _ulid: string;
    started_at: string;
    workflow_ref: string;
    current_step: number;
    total_steps: number;
    completed_at?: string | undefined;
    paused_at?: string | undefined;
    step_results?: {
        status: "completed" | "skipped" | "failed";
        started_at: string;
        completed_at: string;
        step_index: number;
        notes?: string | undefined;
        inputs?: Record<string, string> | undefined;
        entry_confirmed?: boolean | undefined;
        exit_confirmed?: boolean | undefined;
    }[] | undefined;
    initiated_by?: string | undefined;
    abort_reason?: string | undefined;
    task_ref?: string | undefined;
}>;
/**
 * Workflow runs file schema - container for all workflow runs
 */
export declare const WorkflowRunsFileSchema: z.ZodObject<{
    kynetic_runs: z.ZodDefault<z.ZodString>;
    runs: z.ZodDefault<z.ZodArray<z.ZodObject<{
        _ulid: z.ZodString;
        workflow_ref: z.ZodString;
        status: z.ZodEnum<["active", "paused", "completed", "aborted"]>;
        current_step: z.ZodNumber;
        total_steps: z.ZodNumber;
        started_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
        paused_at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>;
        completed_at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>;
        step_results: z.ZodDefault<z.ZodArray<z.ZodObject<{
            step_index: z.ZodNumber;
            status: z.ZodEnum<["completed", "skipped", "failed"]>;
            started_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
            completed_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
            entry_confirmed: z.ZodOptional<z.ZodBoolean>;
            exit_confirmed: z.ZodOptional<z.ZodBoolean>;
            notes: z.ZodOptional<z.ZodString>;
            inputs: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        }, "strip", z.ZodTypeAny, {
            status: "completed" | "skipped" | "failed";
            started_at: string;
            completed_at: string;
            step_index: number;
            notes?: string | undefined;
            inputs?: Record<string, string> | undefined;
            entry_confirmed?: boolean | undefined;
            exit_confirmed?: boolean | undefined;
        }, {
            status: "completed" | "skipped" | "failed";
            started_at: string;
            completed_at: string;
            step_index: number;
            notes?: string | undefined;
            inputs?: Record<string, string> | undefined;
            entry_confirmed?: boolean | undefined;
            exit_confirmed?: boolean | undefined;
        }>, "many">>;
        initiated_by: z.ZodOptional<z.ZodString>;
        abort_reason: z.ZodOptional<z.ZodString>;
        task_ref: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        status: "completed" | "aborted" | "active" | "paused";
        _ulid: string;
        started_at: string;
        workflow_ref: string;
        current_step: number;
        total_steps: number;
        step_results: {
            status: "completed" | "skipped" | "failed";
            started_at: string;
            completed_at: string;
            step_index: number;
            notes?: string | undefined;
            inputs?: Record<string, string> | undefined;
            entry_confirmed?: boolean | undefined;
            exit_confirmed?: boolean | undefined;
        }[];
        completed_at?: string | undefined;
        paused_at?: string | undefined;
        initiated_by?: string | undefined;
        abort_reason?: string | undefined;
        task_ref?: string | undefined;
    }, {
        status: "completed" | "aborted" | "active" | "paused";
        _ulid: string;
        started_at: string;
        workflow_ref: string;
        current_step: number;
        total_steps: number;
        completed_at?: string | undefined;
        paused_at?: string | undefined;
        step_results?: {
            status: "completed" | "skipped" | "failed";
            started_at: string;
            completed_at: string;
            step_index: number;
            notes?: string | undefined;
            inputs?: Record<string, string> | undefined;
            entry_confirmed?: boolean | undefined;
            exit_confirmed?: boolean | undefined;
        }[] | undefined;
        initiated_by?: string | undefined;
        abort_reason?: string | undefined;
        task_ref?: string | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    kynetic_runs: string;
    runs: {
        status: "completed" | "aborted" | "active" | "paused";
        _ulid: string;
        started_at: string;
        workflow_ref: string;
        current_step: number;
        total_steps: number;
        step_results: {
            status: "completed" | "skipped" | "failed";
            started_at: string;
            completed_at: string;
            step_index: number;
            notes?: string | undefined;
            inputs?: Record<string, string> | undefined;
            entry_confirmed?: boolean | undefined;
            exit_confirmed?: boolean | undefined;
        }[];
        completed_at?: string | undefined;
        paused_at?: string | undefined;
        initiated_by?: string | undefined;
        abort_reason?: string | undefined;
        task_ref?: string | undefined;
    }[];
}, {
    kynetic_runs?: string | undefined;
    runs?: {
        status: "completed" | "aborted" | "active" | "paused";
        _ulid: string;
        started_at: string;
        workflow_ref: string;
        current_step: number;
        total_steps: number;
        completed_at?: string | undefined;
        paused_at?: string | undefined;
        step_results?: {
            status: "completed" | "skipped" | "failed";
            started_at: string;
            completed_at: string;
            step_index: number;
            notes?: string | undefined;
            inputs?: Record<string, string> | undefined;
            entry_confirmed?: boolean | undefined;
            exit_confirmed?: boolean | undefined;
        }[] | undefined;
        initiated_by?: string | undefined;
        abort_reason?: string | undefined;
        task_ref?: string | undefined;
    }[] | undefined;
}>;
/**
 * Meta manifest schema - the root structure for kynetic.meta.yaml
 */
export declare const MetaManifestSchema: z.ZodObject<{
    kynetic_meta: z.ZodDefault<z.ZodString>;
    agents: z.ZodDefault<z.ZodArray<z.ZodObject<{
        _ulid: z.ZodString;
        id: z.ZodString;
        name: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        capabilities: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        tools: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        session_protocol: z.ZodOptional<z.ZodObject<{
            start: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            checkpoint: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            end: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        }, "strip", z.ZodTypeAny, {
            start?: string | null | undefined;
            checkpoint?: string | null | undefined;
            end?: string | null | undefined;
        }, {
            start?: string | null | undefined;
            checkpoint?: string | null | undefined;
            end?: string | null | undefined;
        }>>;
        conventions: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        _ulid: string;
        id: string;
        name: string;
        capabilities: string[];
        tools: string[];
        conventions: string[];
        description?: string | undefined;
        session_protocol?: {
            start?: string | null | undefined;
            checkpoint?: string | null | undefined;
            end?: string | null | undefined;
        } | undefined;
    }, {
        _ulid: string;
        id: string;
        name: string;
        description?: string | undefined;
        capabilities?: string[] | undefined;
        tools?: string[] | undefined;
        session_protocol?: {
            start?: string | null | undefined;
            checkpoint?: string | null | undefined;
            end?: string | null | undefined;
        } | undefined;
        conventions?: string[] | undefined;
    }>, "many">>;
    workflows: z.ZodDefault<z.ZodArray<z.ZodObject<{
        _ulid: z.ZodString;
        id: z.ZodString;
        trigger: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        steps: z.ZodDefault<z.ZodArray<z.ZodObject<{
            type: z.ZodEnum<["check", "action", "decision"]>;
            content: z.ZodString;
            on_fail: z.ZodOptional<z.ZodString>;
            options: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            execution: z.ZodOptional<z.ZodObject<{
                mode: z.ZodDefault<z.ZodEnum<["prompt", "silent", "skip"]>>;
                timeout: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            }, "strip", z.ZodTypeAny, {
                mode: "prompt" | "silent" | "skip";
                timeout?: number | null | undefined;
            }, {
                mode?: "prompt" | "silent" | "skip" | undefined;
                timeout?: number | null | undefined;
            }>>;
            entry_criteria: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            exit_criteria: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            inputs: z.ZodOptional<z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                description: z.ZodOptional<z.ZodString>;
                required: z.ZodOptional<z.ZodDefault<z.ZodBoolean>>;
                type: z.ZodOptional<z.ZodDefault<z.ZodEnum<["string", "ref", "number"]>>>;
            }, "strip", z.ZodTypeAny, {
                name: string;
                type?: "string" | "number" | "ref" | undefined;
                description?: string | undefined;
                required?: boolean | undefined;
            }, {
                name: string;
                type?: "string" | "number" | "ref" | undefined;
                description?: string | undefined;
                required?: boolean | undefined;
            }>, "many">>;
        }, "strip", z.ZodTypeAny, {
            type: "action" | "check" | "decision";
            content: string;
            options?: string[] | undefined;
            on_fail?: string | undefined;
            execution?: {
                mode: "prompt" | "silent" | "skip";
                timeout?: number | null | undefined;
            } | undefined;
            entry_criteria?: string[] | undefined;
            exit_criteria?: string[] | undefined;
            inputs?: {
                name: string;
                type?: "string" | "number" | "ref" | undefined;
                description?: string | undefined;
                required?: boolean | undefined;
            }[] | undefined;
        }, {
            type: "action" | "check" | "decision";
            content: string;
            options?: string[] | undefined;
            on_fail?: string | undefined;
            execution?: {
                mode?: "prompt" | "silent" | "skip" | undefined;
                timeout?: number | null | undefined;
            } | undefined;
            entry_criteria?: string[] | undefined;
            exit_criteria?: string[] | undefined;
            inputs?: {
                name: string;
                type?: "string" | "number" | "ref" | undefined;
                description?: string | undefined;
                required?: boolean | undefined;
            }[] | undefined;
        }>, "many">>;
        enforcement: z.ZodOptional<z.ZodDefault<z.ZodEnum<["advisory", "strict"]>>>;
    }, "strip", z.ZodTypeAny, {
        _ulid: string;
        id: string;
        trigger: string;
        steps: {
            type: "action" | "check" | "decision";
            content: string;
            options?: string[] | undefined;
            on_fail?: string | undefined;
            execution?: {
                mode: "prompt" | "silent" | "skip";
                timeout?: number | null | undefined;
            } | undefined;
            entry_criteria?: string[] | undefined;
            exit_criteria?: string[] | undefined;
            inputs?: {
                name: string;
                type?: "string" | "number" | "ref" | undefined;
                description?: string | undefined;
                required?: boolean | undefined;
            }[] | undefined;
        }[];
        description?: string | undefined;
        enforcement?: "advisory" | "strict" | undefined;
    }, {
        _ulid: string;
        id: string;
        trigger: string;
        description?: string | undefined;
        steps?: {
            type: "action" | "check" | "decision";
            content: string;
            options?: string[] | undefined;
            on_fail?: string | undefined;
            execution?: {
                mode?: "prompt" | "silent" | "skip" | undefined;
                timeout?: number | null | undefined;
            } | undefined;
            entry_criteria?: string[] | undefined;
            exit_criteria?: string[] | undefined;
            inputs?: {
                name: string;
                type?: "string" | "number" | "ref" | undefined;
                description?: string | undefined;
                required?: boolean | undefined;
            }[] | undefined;
        }[] | undefined;
        enforcement?: "advisory" | "strict" | undefined;
    }>, "many">>;
    conventions: z.ZodDefault<z.ZodArray<z.ZodObject<{
        _ulid: z.ZodString;
        domain: z.ZodString;
        rules: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        examples: z.ZodDefault<z.ZodArray<z.ZodObject<{
            good: z.ZodString;
            bad: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            good: string;
            bad: string;
        }, {
            good: string;
            bad: string;
        }>, "many">>;
        validation: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<["regex", "enum", "range", "prose"]>;
            pattern: z.ZodOptional<z.ZodString>;
            message: z.ZodOptional<z.ZodString>;
            allowed: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
            min: z.ZodOptional<z.ZodNumber>;
            max: z.ZodOptional<z.ZodNumber>;
            unit: z.ZodOptional<z.ZodEnum<["words", "chars", "lines"]>>;
        }, "strip", z.ZodTypeAny, {
            type: "regex" | "enum" | "range" | "prose";
            message?: string | undefined;
            pattern?: string | undefined;
            allowed?: string[] | undefined;
            min?: number | undefined;
            max?: number | undefined;
            unit?: "lines" | "words" | "chars" | undefined;
        }, {
            type: "regex" | "enum" | "range" | "prose";
            message?: string | undefined;
            pattern?: string | undefined;
            allowed?: string[] | undefined;
            min?: number | undefined;
            max?: number | undefined;
            unit?: "lines" | "words" | "chars" | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        _ulid: string;
        domain: string;
        rules: string[];
        examples: {
            good: string;
            bad: string;
        }[];
        validation?: {
            type: "regex" | "enum" | "range" | "prose";
            message?: string | undefined;
            pattern?: string | undefined;
            allowed?: string[] | undefined;
            min?: number | undefined;
            max?: number | undefined;
            unit?: "lines" | "words" | "chars" | undefined;
        } | undefined;
    }, {
        _ulid: string;
        domain: string;
        validation?: {
            type: "regex" | "enum" | "range" | "prose";
            message?: string | undefined;
            pattern?: string | undefined;
            allowed?: string[] | undefined;
            min?: number | undefined;
            max?: number | undefined;
            unit?: "lines" | "words" | "chars" | undefined;
        } | undefined;
        rules?: string[] | undefined;
        examples?: {
            good: string;
            bad: string;
        }[] | undefined;
    }>, "many">>;
    observations: z.ZodDefault<z.ZodArray<z.ZodObject<{
        _ulid: z.ZodString;
        type: z.ZodEnum<["friction", "success", "question", "idea"]>;
        workflow_ref: z.ZodOptional<z.ZodString>;
        content: z.ZodString;
        created_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
        author: z.ZodOptional<z.ZodString>;
        resolved: z.ZodDefault<z.ZodBoolean>;
        resolution: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        resolved_at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>;
        resolved_by: z.ZodOptional<z.ZodString>;
        promoted_to: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "friction" | "success" | "question" | "idea";
        _ulid: string;
        created_at: string;
        content: string;
        resolved: boolean;
        author?: string | undefined;
        promoted_to?: string | undefined;
        workflow_ref?: string | undefined;
        resolution?: string | null | undefined;
        resolved_at?: string | undefined;
        resolved_by?: string | undefined;
    }, {
        type: "friction" | "success" | "question" | "idea";
        _ulid: string;
        created_at: string;
        content: string;
        author?: string | undefined;
        promoted_to?: string | undefined;
        workflow_ref?: string | undefined;
        resolved?: boolean | undefined;
        resolution?: string | null | undefined;
        resolved_at?: string | undefined;
        resolved_by?: string | undefined;
    }>, "many">>;
    includes: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    includes: string[];
    conventions: {
        _ulid: string;
        domain: string;
        rules: string[];
        examples: {
            good: string;
            bad: string;
        }[];
        validation?: {
            type: "regex" | "enum" | "range" | "prose";
            message?: string | undefined;
            pattern?: string | undefined;
            allowed?: string[] | undefined;
            min?: number | undefined;
            max?: number | undefined;
            unit?: "lines" | "words" | "chars" | undefined;
        } | undefined;
    }[];
    kynetic_meta: string;
    agents: {
        _ulid: string;
        id: string;
        name: string;
        capabilities: string[];
        tools: string[];
        conventions: string[];
        description?: string | undefined;
        session_protocol?: {
            start?: string | null | undefined;
            checkpoint?: string | null | undefined;
            end?: string | null | undefined;
        } | undefined;
    }[];
    workflows: {
        _ulid: string;
        id: string;
        trigger: string;
        steps: {
            type: "action" | "check" | "decision";
            content: string;
            options?: string[] | undefined;
            on_fail?: string | undefined;
            execution?: {
                mode: "prompt" | "silent" | "skip";
                timeout?: number | null | undefined;
            } | undefined;
            entry_criteria?: string[] | undefined;
            exit_criteria?: string[] | undefined;
            inputs?: {
                name: string;
                type?: "string" | "number" | "ref" | undefined;
                description?: string | undefined;
                required?: boolean | undefined;
            }[] | undefined;
        }[];
        description?: string | undefined;
        enforcement?: "advisory" | "strict" | undefined;
    }[];
    observations: {
        type: "friction" | "success" | "question" | "idea";
        _ulid: string;
        created_at: string;
        content: string;
        resolved: boolean;
        author?: string | undefined;
        promoted_to?: string | undefined;
        workflow_ref?: string | undefined;
        resolution?: string | null | undefined;
        resolved_at?: string | undefined;
        resolved_by?: string | undefined;
    }[];
}, {
    includes?: string[] | undefined;
    conventions?: {
        _ulid: string;
        domain: string;
        validation?: {
            type: "regex" | "enum" | "range" | "prose";
            message?: string | undefined;
            pattern?: string | undefined;
            allowed?: string[] | undefined;
            min?: number | undefined;
            max?: number | undefined;
            unit?: "lines" | "words" | "chars" | undefined;
        } | undefined;
        rules?: string[] | undefined;
        examples?: {
            good: string;
            bad: string;
        }[] | undefined;
    }[] | undefined;
    kynetic_meta?: string | undefined;
    agents?: {
        _ulid: string;
        id: string;
        name: string;
        description?: string | undefined;
        capabilities?: string[] | undefined;
        tools?: string[] | undefined;
        session_protocol?: {
            start?: string | null | undefined;
            checkpoint?: string | null | undefined;
            end?: string | null | undefined;
        } | undefined;
        conventions?: string[] | undefined;
    }[] | undefined;
    workflows?: {
        _ulid: string;
        id: string;
        trigger: string;
        description?: string | undefined;
        steps?: {
            type: "action" | "check" | "decision";
            content: string;
            options?: string[] | undefined;
            on_fail?: string | undefined;
            execution?: {
                mode?: "prompt" | "silent" | "skip" | undefined;
                timeout?: number | null | undefined;
            } | undefined;
            entry_criteria?: string[] | undefined;
            exit_criteria?: string[] | undefined;
            inputs?: {
                name: string;
                type?: "string" | "number" | "ref" | undefined;
                description?: string | undefined;
                required?: boolean | undefined;
            }[] | undefined;
        }[] | undefined;
        enforcement?: "advisory" | "strict" | undefined;
    }[] | undefined;
    observations?: {
        type: "friction" | "success" | "question" | "idea";
        _ulid: string;
        created_at: string;
        content: string;
        author?: string | undefined;
        promoted_to?: string | undefined;
        workflow_ref?: string | undefined;
        resolved?: boolean | undefined;
        resolution?: string | null | undefined;
        resolved_at?: string | undefined;
        resolved_by?: string | undefined;
    }[] | undefined;
}>;
export type SessionProtocol = z.infer<typeof SessionProtocolSchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type WorkflowStepType = z.infer<typeof WorkflowStepTypeSchema>;
export type StepExecution = z.infer<typeof StepExecutionSchema>;
export type StepInput = z.infer<typeof StepInputSchema>;
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type ConventionExample = z.infer<typeof ConventionExampleSchema>;
export type ConventionValidation = z.infer<typeof ConventionValidationSchema>;
export type Convention = z.infer<typeof ConventionSchema>;
export type ObservationType = z.infer<typeof ObservationTypeSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type SessionContext = z.infer<typeof SessionContextSchema>;
export type MetaManifest = z.infer<typeof MetaManifestSchema>;
export type StepResultStatus = z.infer<typeof StepResultStatusSchema>;
export type StepResult = z.infer<typeof StepResultSchema>;
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
export type WorkflowRunsFile = z.infer<typeof WorkflowRunsFileSchema>;
/**
 * Meta item type - union of all meta item types
 */
export type MetaItem = Agent | Workflow | Convention | Observation;
/**
 * Determine the type of a meta item
 */
export declare function getMetaItemType(item: MetaItem): "agent" | "workflow" | "convention" | "observation";
//# sourceMappingURL=meta.d.ts.map