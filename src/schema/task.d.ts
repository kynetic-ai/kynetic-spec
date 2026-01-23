import { z } from "zod";
/**
 * Automation eligibility status for tasks
 * AC: @task-automation-eligibility ac-1
 * - eligible: Task can be processed by automation loops
 * - needs_review: Task was rejected by automation and needs human review
 * - manual_only: Task should only be handled by humans
 * - undefined/absent: Task has not been assessed for automation (unassessed)
 */
export declare const AutomationStatusSchema: z.ZodEnum<["eligible", "needs_review", "manual_only"]>;
/**
 * Note entry - append-only work log
 */
export declare const NoteSchema: z.ZodObject<{
    _ulid: z.ZodString;
    created_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
    author: z.ZodOptional<z.ZodString>;
    content: z.ZodString;
    supersedes: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    _ulid: string;
    created_at: string;
    content: string;
    author?: string | undefined;
    supersedes?: string | null | undefined;
}, {
    _ulid: string;
    created_at: string;
    content: string;
    author?: string | undefined;
    supersedes?: string | null | undefined;
}>;
/**
 * Todo item - lightweight checklist
 */
export declare const TodoSchema: z.ZodObject<{
    id: z.ZodNumber;
    text: z.ZodString;
    done: z.ZodDefault<z.ZodBoolean>;
    done_at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>;
    added_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
    added_by: z.ZodOptional<z.ZodString>;
    promoted_to: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: number;
    text: string;
    done: boolean;
    added_at: string;
    done_at?: string | undefined;
    added_by?: string | undefined;
    promoted_to?: string | undefined;
}, {
    id: number;
    text: string;
    added_at: string;
    done?: boolean | undefined;
    done_at?: string | undefined;
    added_by?: string | undefined;
    promoted_to?: string | undefined;
}>;
/**
 * Full task schema
 * Note: created_at defaults to now if not provided (auto-populated on load)
 */
export declare const TaskSchema: z.ZodObject<{
    _ulid: z.ZodString;
    slugs: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    title: z.ZodString;
    type: z.ZodDefault<z.ZodEnum<["epic", "task", "bug", "spike", "infra"]>>;
    description: z.ZodOptional<z.ZodString>;
    spec_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    derivation: z.ZodOptional<z.ZodEnum<["auto", "manual"]>>;
    meta_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    origin: z.ZodOptional<z.ZodEnum<["manual", "derived", "observation_promotion"]>>;
    status: z.ZodDefault<z.ZodEnum<["pending", "in_progress", "pending_review", "blocked", "completed", "cancelled"]>>;
    blocked_by: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    closed_reason: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    depends_on: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    context: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    priority: z.ZodDefault<z.ZodNumber>;
    complexity: z.ZodOptional<z.ZodNumber>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    assignee: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    vcs_refs: z.ZodDefault<z.ZodArray<z.ZodObject<{
        ref: z.ZodString;
        type: z.ZodOptional<z.ZodEnum<["branch", "tag", "commit"]>>;
    }, "strip", z.ZodTypeAny, {
        ref: string;
        type?: "branch" | "tag" | "commit" | undefined;
    }, {
        ref: string;
        type?: "branch" | "tag" | "commit" | undefined;
    }>, "many">>;
    created_at: z.ZodDefault<z.ZodUnion<[z.ZodString, z.ZodString]>>;
    started_at: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>;
    completed_at: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>;
    notes: z.ZodDefault<z.ZodArray<z.ZodObject<{
        _ulid: z.ZodString;
        created_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
        author: z.ZodOptional<z.ZodString>;
        content: z.ZodString;
        supersedes: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        _ulid: string;
        created_at: string;
        content: string;
        author?: string | undefined;
        supersedes?: string | null | undefined;
    }, {
        _ulid: string;
        created_at: string;
        content: string;
        author?: string | undefined;
        supersedes?: string | null | undefined;
    }>, "many">>;
    todos: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodNumber;
        text: z.ZodString;
        done: z.ZodDefault<z.ZodBoolean>;
        done_at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>;
        added_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
        added_by: z.ZodOptional<z.ZodString>;
        promoted_to: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: number;
        text: string;
        done: boolean;
        added_at: string;
        done_at?: string | undefined;
        added_by?: string | undefined;
        promoted_to?: string | undefined;
    }, {
        id: number;
        text: string;
        added_at: string;
        done?: boolean | undefined;
        done_at?: string | undefined;
        added_by?: string | undefined;
        promoted_to?: string | undefined;
    }>, "many">>;
    automation: z.ZodOptional<z.ZodEnum<["eligible", "needs_review", "manual_only"]>>;
}, "strip", z.ZodTypeAny, {
    status: "pending" | "in_progress" | "completed" | "pending_review" | "blocked" | "cancelled";
    type: "task" | "epic" | "bug" | "spike" | "infra";
    _ulid: string;
    created_at: string;
    slugs: string[];
    title: string;
    blocked_by: string[];
    depends_on: string[];
    context: string[];
    priority: number;
    tags: string[];
    vcs_refs: {
        ref: string;
        type?: "branch" | "tag" | "commit" | undefined;
    }[];
    notes: {
        _ulid: string;
        created_at: string;
        content: string;
        author?: string | undefined;
        supersedes?: string | null | undefined;
    }[];
    todos: {
        id: number;
        text: string;
        done: boolean;
        added_at: string;
        done_at?: string | undefined;
        added_by?: string | undefined;
        promoted_to?: string | undefined;
    }[];
    description?: string | undefined;
    spec_ref?: string | null | undefined;
    derivation?: "auto" | "manual" | undefined;
    meta_ref?: string | null | undefined;
    origin?: "manual" | "derived" | "observation_promotion" | undefined;
    closed_reason?: string | null | undefined;
    complexity?: number | undefined;
    assignee?: string | null | undefined;
    started_at?: string | null | undefined;
    completed_at?: string | null | undefined;
    automation?: "eligible" | "needs_review" | "manual_only" | undefined;
}, {
    _ulid: string;
    title: string;
    status?: "pending" | "in_progress" | "completed" | "pending_review" | "blocked" | "cancelled" | undefined;
    type?: "task" | "epic" | "bug" | "spike" | "infra" | undefined;
    created_at?: string | undefined;
    slugs?: string[] | undefined;
    description?: string | undefined;
    spec_ref?: string | null | undefined;
    derivation?: "auto" | "manual" | undefined;
    meta_ref?: string | null | undefined;
    origin?: "manual" | "derived" | "observation_promotion" | undefined;
    blocked_by?: string[] | undefined;
    closed_reason?: string | null | undefined;
    depends_on?: string[] | undefined;
    context?: string[] | undefined;
    priority?: number | undefined;
    complexity?: number | undefined;
    tags?: string[] | undefined;
    assignee?: string | null | undefined;
    vcs_refs?: {
        ref: string;
        type?: "branch" | "tag" | "commit" | undefined;
    }[] | undefined;
    started_at?: string | null | undefined;
    completed_at?: string | null | undefined;
    notes?: {
        _ulid: string;
        created_at: string;
        content: string;
        author?: string | undefined;
        supersedes?: string | null | undefined;
    }[] | undefined;
    todos?: {
        id: number;
        text: string;
        added_at: string;
        done?: boolean | undefined;
        done_at?: string | undefined;
        added_by?: string | undefined;
        promoted_to?: string | undefined;
    }[] | undefined;
    automation?: "eligible" | "needs_review" | "manual_only" | undefined;
}>;
/**
 * Task input schema (for creating new tasks, some fields auto-generated)
 * All fields except title are optional - defaults will be applied
 */
export declare const TaskInputSchema: z.ZodObject<{
    _ulid: z.ZodOptional<z.ZodString>;
    slugs: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    title: z.ZodString;
    type: z.ZodOptional<z.ZodEnum<["epic", "task", "bug", "spike", "infra"]>>;
    description: z.ZodOptional<z.ZodString>;
    spec_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    derivation: z.ZodOptional<z.ZodEnum<["auto", "manual"]>>;
    meta_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    origin: z.ZodOptional<z.ZodEnum<["manual", "derived", "observation_promotion"]>>;
    status: z.ZodOptional<z.ZodEnum<["pending", "in_progress", "pending_review", "blocked", "completed", "cancelled"]>>;
    blocked_by: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    closed_reason: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    depends_on: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    context: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    priority: z.ZodOptional<z.ZodNumber>;
    complexity: z.ZodOptional<z.ZodNumber>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    assignee: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    vcs_refs: z.ZodOptional<z.ZodArray<z.ZodObject<{
        ref: z.ZodString;
        type: z.ZodOptional<z.ZodEnum<["branch", "tag", "commit"]>>;
    }, "strip", z.ZodTypeAny, {
        ref: string;
        type?: "branch" | "tag" | "commit" | undefined;
    }, {
        ref: string;
        type?: "branch" | "tag" | "commit" | undefined;
    }>, "many">>;
    created_at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>;
    started_at: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>;
    completed_at: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>;
    notes: z.ZodOptional<z.ZodArray<z.ZodObject<{
        _ulid: z.ZodString;
        created_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
        author: z.ZodOptional<z.ZodString>;
        content: z.ZodString;
        supersedes: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        _ulid: string;
        created_at: string;
        content: string;
        author?: string | undefined;
        supersedes?: string | null | undefined;
    }, {
        _ulid: string;
        created_at: string;
        content: string;
        author?: string | undefined;
        supersedes?: string | null | undefined;
    }>, "many">>;
    todos: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodNumber;
        text: z.ZodString;
        done: z.ZodDefault<z.ZodBoolean>;
        done_at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>;
        added_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
        added_by: z.ZodOptional<z.ZodString>;
        promoted_to: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: number;
        text: string;
        done: boolean;
        added_at: string;
        done_at?: string | undefined;
        added_by?: string | undefined;
        promoted_to?: string | undefined;
    }, {
        id: number;
        text: string;
        added_at: string;
        done?: boolean | undefined;
        done_at?: string | undefined;
        added_by?: string | undefined;
        promoted_to?: string | undefined;
    }>, "many">>;
    automation: z.ZodOptional<z.ZodEnum<["eligible", "needs_review", "manual_only"]>>;
}, "strip", z.ZodTypeAny, {
    title: string;
    status?: "pending" | "in_progress" | "completed" | "pending_review" | "blocked" | "cancelled" | undefined;
    type?: "task" | "epic" | "bug" | "spike" | "infra" | undefined;
    _ulid?: string | undefined;
    created_at?: string | undefined;
    slugs?: string[] | undefined;
    description?: string | undefined;
    spec_ref?: string | null | undefined;
    derivation?: "auto" | "manual" | undefined;
    meta_ref?: string | null | undefined;
    origin?: "manual" | "derived" | "observation_promotion" | undefined;
    blocked_by?: string[] | undefined;
    closed_reason?: string | null | undefined;
    depends_on?: string[] | undefined;
    context?: string[] | undefined;
    priority?: number | undefined;
    complexity?: number | undefined;
    tags?: string[] | undefined;
    assignee?: string | null | undefined;
    vcs_refs?: {
        ref: string;
        type?: "branch" | "tag" | "commit" | undefined;
    }[] | undefined;
    started_at?: string | null | undefined;
    completed_at?: string | null | undefined;
    notes?: {
        _ulid: string;
        created_at: string;
        content: string;
        author?: string | undefined;
        supersedes?: string | null | undefined;
    }[] | undefined;
    todos?: {
        id: number;
        text: string;
        done: boolean;
        added_at: string;
        done_at?: string | undefined;
        added_by?: string | undefined;
        promoted_to?: string | undefined;
    }[] | undefined;
    automation?: "eligible" | "needs_review" | "manual_only" | undefined;
}, {
    title: string;
    status?: "pending" | "in_progress" | "completed" | "pending_review" | "blocked" | "cancelled" | undefined;
    type?: "task" | "epic" | "bug" | "spike" | "infra" | undefined;
    _ulid?: string | undefined;
    created_at?: string | undefined;
    slugs?: string[] | undefined;
    description?: string | undefined;
    spec_ref?: string | null | undefined;
    derivation?: "auto" | "manual" | undefined;
    meta_ref?: string | null | undefined;
    origin?: "manual" | "derived" | "observation_promotion" | undefined;
    blocked_by?: string[] | undefined;
    closed_reason?: string | null | undefined;
    depends_on?: string[] | undefined;
    context?: string[] | undefined;
    priority?: number | undefined;
    complexity?: number | undefined;
    tags?: string[] | undefined;
    assignee?: string | null | undefined;
    vcs_refs?: {
        ref: string;
        type?: "branch" | "tag" | "commit" | undefined;
    }[] | undefined;
    started_at?: string | null | undefined;
    completed_at?: string | null | undefined;
    notes?: {
        _ulid: string;
        created_at: string;
        content: string;
        author?: string | undefined;
        supersedes?: string | null | undefined;
    }[] | undefined;
    todos?: {
        id: number;
        text: string;
        added_at: string;
        done?: boolean | undefined;
        done_at?: string | undefined;
        added_by?: string | undefined;
        promoted_to?: string | undefined;
    }[] | undefined;
    automation?: "eligible" | "needs_review" | "manual_only" | undefined;
}>;
/**
 * Tasks file schema (collection of tasks)
 */
export declare const TasksFileSchema: z.ZodObject<{
    kynetic_tasks: z.ZodDefault<z.ZodString>;
    tasks: z.ZodArray<z.ZodObject<{
        _ulid: z.ZodString;
        slugs: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        title: z.ZodString;
        type: z.ZodDefault<z.ZodEnum<["epic", "task", "bug", "spike", "infra"]>>;
        description: z.ZodOptional<z.ZodString>;
        spec_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        derivation: z.ZodOptional<z.ZodEnum<["auto", "manual"]>>;
        meta_ref: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        origin: z.ZodOptional<z.ZodEnum<["manual", "derived", "observation_promotion"]>>;
        status: z.ZodDefault<z.ZodEnum<["pending", "in_progress", "pending_review", "blocked", "completed", "cancelled"]>>;
        blocked_by: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        closed_reason: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        depends_on: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        context: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        priority: z.ZodDefault<z.ZodNumber>;
        complexity: z.ZodOptional<z.ZodNumber>;
        tags: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        assignee: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        vcs_refs: z.ZodDefault<z.ZodArray<z.ZodObject<{
            ref: z.ZodString;
            type: z.ZodOptional<z.ZodEnum<["branch", "tag", "commit"]>>;
        }, "strip", z.ZodTypeAny, {
            ref: string;
            type?: "branch" | "tag" | "commit" | undefined;
        }, {
            ref: string;
            type?: "branch" | "tag" | "commit" | undefined;
        }>, "many">>;
        created_at: z.ZodDefault<z.ZodUnion<[z.ZodString, z.ZodString]>>;
        started_at: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>;
        completed_at: z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>;
        notes: z.ZodDefault<z.ZodArray<z.ZodObject<{
            _ulid: z.ZodString;
            created_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
            author: z.ZodOptional<z.ZodString>;
            content: z.ZodString;
            supersedes: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        }, "strip", z.ZodTypeAny, {
            _ulid: string;
            created_at: string;
            content: string;
            author?: string | undefined;
            supersedes?: string | null | undefined;
        }, {
            _ulid: string;
            created_at: string;
            content: string;
            author?: string | undefined;
            supersedes?: string | null | undefined;
        }>, "many">>;
        todos: z.ZodDefault<z.ZodArray<z.ZodObject<{
            id: z.ZodNumber;
            text: z.ZodString;
            done: z.ZodDefault<z.ZodBoolean>;
            done_at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>;
            added_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
            added_by: z.ZodOptional<z.ZodString>;
            promoted_to: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            id: number;
            text: string;
            done: boolean;
            added_at: string;
            done_at?: string | undefined;
            added_by?: string | undefined;
            promoted_to?: string | undefined;
        }, {
            id: number;
            text: string;
            added_at: string;
            done?: boolean | undefined;
            done_at?: string | undefined;
            added_by?: string | undefined;
            promoted_to?: string | undefined;
        }>, "many">>;
        automation: z.ZodOptional<z.ZodEnum<["eligible", "needs_review", "manual_only"]>>;
    }, "strip", z.ZodTypeAny, {
        status: "pending" | "in_progress" | "completed" | "pending_review" | "blocked" | "cancelled";
        type: "task" | "epic" | "bug" | "spike" | "infra";
        _ulid: string;
        created_at: string;
        slugs: string[];
        title: string;
        blocked_by: string[];
        depends_on: string[];
        context: string[];
        priority: number;
        tags: string[];
        vcs_refs: {
            ref: string;
            type?: "branch" | "tag" | "commit" | undefined;
        }[];
        notes: {
            _ulid: string;
            created_at: string;
            content: string;
            author?: string | undefined;
            supersedes?: string | null | undefined;
        }[];
        todos: {
            id: number;
            text: string;
            done: boolean;
            added_at: string;
            done_at?: string | undefined;
            added_by?: string | undefined;
            promoted_to?: string | undefined;
        }[];
        description?: string | undefined;
        spec_ref?: string | null | undefined;
        derivation?: "auto" | "manual" | undefined;
        meta_ref?: string | null | undefined;
        origin?: "manual" | "derived" | "observation_promotion" | undefined;
        closed_reason?: string | null | undefined;
        complexity?: number | undefined;
        assignee?: string | null | undefined;
        started_at?: string | null | undefined;
        completed_at?: string | null | undefined;
        automation?: "eligible" | "needs_review" | "manual_only" | undefined;
    }, {
        _ulid: string;
        title: string;
        status?: "pending" | "in_progress" | "completed" | "pending_review" | "blocked" | "cancelled" | undefined;
        type?: "task" | "epic" | "bug" | "spike" | "infra" | undefined;
        created_at?: string | undefined;
        slugs?: string[] | undefined;
        description?: string | undefined;
        spec_ref?: string | null | undefined;
        derivation?: "auto" | "manual" | undefined;
        meta_ref?: string | null | undefined;
        origin?: "manual" | "derived" | "observation_promotion" | undefined;
        blocked_by?: string[] | undefined;
        closed_reason?: string | null | undefined;
        depends_on?: string[] | undefined;
        context?: string[] | undefined;
        priority?: number | undefined;
        complexity?: number | undefined;
        tags?: string[] | undefined;
        assignee?: string | null | undefined;
        vcs_refs?: {
            ref: string;
            type?: "branch" | "tag" | "commit" | undefined;
        }[] | undefined;
        started_at?: string | null | undefined;
        completed_at?: string | null | undefined;
        notes?: {
            _ulid: string;
            created_at: string;
            content: string;
            author?: string | undefined;
            supersedes?: string | null | undefined;
        }[] | undefined;
        todos?: {
            id: number;
            text: string;
            added_at: string;
            done?: boolean | undefined;
            done_at?: string | undefined;
            added_by?: string | undefined;
            promoted_to?: string | undefined;
        }[] | undefined;
        automation?: "eligible" | "needs_review" | "manual_only" | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    kynetic_tasks: string;
    tasks: {
        status: "pending" | "in_progress" | "completed" | "pending_review" | "blocked" | "cancelled";
        type: "task" | "epic" | "bug" | "spike" | "infra";
        _ulid: string;
        created_at: string;
        slugs: string[];
        title: string;
        blocked_by: string[];
        depends_on: string[];
        context: string[];
        priority: number;
        tags: string[];
        vcs_refs: {
            ref: string;
            type?: "branch" | "tag" | "commit" | undefined;
        }[];
        notes: {
            _ulid: string;
            created_at: string;
            content: string;
            author?: string | undefined;
            supersedes?: string | null | undefined;
        }[];
        todos: {
            id: number;
            text: string;
            done: boolean;
            added_at: string;
            done_at?: string | undefined;
            added_by?: string | undefined;
            promoted_to?: string | undefined;
        }[];
        description?: string | undefined;
        spec_ref?: string | null | undefined;
        derivation?: "auto" | "manual" | undefined;
        meta_ref?: string | null | undefined;
        origin?: "manual" | "derived" | "observation_promotion" | undefined;
        closed_reason?: string | null | undefined;
        complexity?: number | undefined;
        assignee?: string | null | undefined;
        started_at?: string | null | undefined;
        completed_at?: string | null | undefined;
        automation?: "eligible" | "needs_review" | "manual_only" | undefined;
    }[];
}, {
    tasks: {
        _ulid: string;
        title: string;
        status?: "pending" | "in_progress" | "completed" | "pending_review" | "blocked" | "cancelled" | undefined;
        type?: "task" | "epic" | "bug" | "spike" | "infra" | undefined;
        created_at?: string | undefined;
        slugs?: string[] | undefined;
        description?: string | undefined;
        spec_ref?: string | null | undefined;
        derivation?: "auto" | "manual" | undefined;
        meta_ref?: string | null | undefined;
        origin?: "manual" | "derived" | "observation_promotion" | undefined;
        blocked_by?: string[] | undefined;
        closed_reason?: string | null | undefined;
        depends_on?: string[] | undefined;
        context?: string[] | undefined;
        priority?: number | undefined;
        complexity?: number | undefined;
        tags?: string[] | undefined;
        assignee?: string | null | undefined;
        vcs_refs?: {
            ref: string;
            type?: "branch" | "tag" | "commit" | undefined;
        }[] | undefined;
        started_at?: string | null | undefined;
        completed_at?: string | null | undefined;
        notes?: {
            _ulid: string;
            created_at: string;
            content: string;
            author?: string | undefined;
            supersedes?: string | null | undefined;
        }[] | undefined;
        todos?: {
            id: number;
            text: string;
            added_at: string;
            done?: boolean | undefined;
            done_at?: string | undefined;
            added_by?: string | undefined;
            promoted_to?: string | undefined;
        }[] | undefined;
        automation?: "eligible" | "needs_review" | "manual_only" | undefined;
    }[];
    kynetic_tasks?: string | undefined;
}>;
export type Note = z.infer<typeof NoteSchema>;
export type Todo = z.infer<typeof TodoSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskInput = z.infer<typeof TaskInputSchema>;
export type TasksFile = z.infer<typeof TasksFileSchema>;
//# sourceMappingURL=task.d.ts.map