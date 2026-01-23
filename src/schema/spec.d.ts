import { z } from "zod";
/**
 * Status block for spec items
 */
export declare const StatusSchema: z.ZodObject<{
    maturity: z.ZodDefault<z.ZodEnum<["draft", "proposed", "stable", "deferred", "deprecated"]>>;
    implementation: z.ZodDefault<z.ZodEnum<["not_started", "in_progress", "implemented", "verified"]>>;
}, "strip", z.ZodTypeAny, {
    maturity: "draft" | "proposed" | "stable" | "deferred" | "deprecated";
    implementation: "in_progress" | "not_started" | "implemented" | "verified";
}, {
    maturity?: "draft" | "proposed" | "stable" | "deferred" | "deprecated" | undefined;
    implementation?: "in_progress" | "not_started" | "implemented" | "verified" | undefined;
}>;
/**
 * Acceptance criteria in Given/When/Then format
 */
export declare const AcceptanceCriterionSchema: z.ZodObject<{
    id: z.ZodString;
    given: z.ZodString;
    when: z.ZodString;
    then: z.ZodString;
}, "strip", z.ZodTypeAny, {
    id: string;
    given: string;
    when: string;
    then: string;
}, {
    id: string;
    given: string;
    when: string;
    then: string;
}>;
/**
 * Implementation traceability
 */
export declare const ImplementationRefSchema: z.ZodObject<{
    path: z.ZodString;
    function: z.ZodOptional<z.ZodString>;
    lines: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    path: string;
    function?: string | undefined;
    lines?: string | undefined;
}, {
    path: string;
    function?: string | undefined;
    lines?: string | undefined;
}>;
/**
 * Traceability block
 */
export declare const TraceabilitySchema: z.ZodObject<{
    implementation: z.ZodOptional<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        function: z.ZodOptional<z.ZodString>;
        lines: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        path: string;
        function?: string | undefined;
        lines?: string | undefined;
    }, {
        path: string;
        function?: string | undefined;
        lines?: string | undefined;
    }>, "many">>;
    tests: z.ZodOptional<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        path: string;
    }, {
        path: string;
    }>, "many">>;
    commits: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    issues: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    issues?: string[] | undefined;
    implementation?: {
        path: string;
        function?: string | undefined;
        lines?: string | undefined;
    }[] | undefined;
    tests?: {
        path: string;
    }[] | undefined;
    commits?: string[] | undefined;
}, {
    issues?: string[] | undefined;
    implementation?: {
        path: string;
        function?: string | undefined;
        lines?: string | undefined;
    }[] | undefined;
    tests?: {
        path: string;
    }[] | undefined;
    commits?: string[] | undefined;
}>;
/**
 * Full spec item schema
 */
export declare const SpecItemSchema: z.ZodObject<{
    _ulid: z.ZodString;
    slugs: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    title: z.ZodString;
    type: z.ZodOptional<z.ZodEnum<["module", "feature", "requirement", "constraint", "decision", "task", "trait"]>>;
    status: z.ZodOptional<z.ZodObject<{
        maturity: z.ZodDefault<z.ZodEnum<["draft", "proposed", "stable", "deferred", "deprecated"]>>;
        implementation: z.ZodDefault<z.ZodEnum<["not_started", "in_progress", "implemented", "verified"]>>;
    }, "strip", z.ZodTypeAny, {
        maturity: "draft" | "proposed" | "stable" | "deferred" | "deprecated";
        implementation: "in_progress" | "not_started" | "implemented" | "verified";
    }, {
        maturity?: "draft" | "proposed" | "stable" | "deferred" | "deprecated" | undefined;
        implementation?: "in_progress" | "not_started" | "implemented" | "verified" | undefined;
    }>>;
    priority: z.ZodOptional<z.ZodUnion<[z.ZodEnum<["high", "medium", "low"]>, z.ZodNumber]>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    description: z.ZodOptional<z.ZodString>;
    acceptance_criteria: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        given: z.ZodString;
        when: z.ZodString;
        then: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        given: string;
        when: string;
        then: string;
    }, {
        id: string;
        given: string;
        when: string;
        then: string;
    }>, "many">>;
    depends_on: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    implements: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    relates_to: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    tests: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    traits: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    supersedes: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    traceability: z.ZodOptional<z.ZodObject<{
        implementation: z.ZodOptional<z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            function: z.ZodOptional<z.ZodString>;
            lines: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }, {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }>, "many">>;
        tests: z.ZodOptional<z.ZodArray<z.ZodObject<{
            path: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            path: string;
        }, {
            path: string;
        }>, "many">>;
        commits: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        issues: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        issues?: string[] | undefined;
        implementation?: {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }[] | undefined;
        tests?: {
            path: string;
        }[] | undefined;
        commits?: string[] | undefined;
    }, {
        issues?: string[] | undefined;
        implementation?: {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }[] | undefined;
        tests?: {
            path: string;
        }[] | undefined;
        commits?: string[] | undefined;
    }>>;
    created: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>;
    created_by: z.ZodOptional<z.ZodString>;
    deprecated_in: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    verified_at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>;
    verified_by: z.ZodOptional<z.ZodString>;
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
}, "strip", z.ZodTypeAny, {
    _ulid: string;
    slugs: string[];
    title: string;
    depends_on: string[];
    tags: string[];
    notes: {
        _ulid: string;
        created_at: string;
        content: string;
        author?: string | undefined;
        supersedes?: string | null | undefined;
    }[];
    tests: string[];
    implements: string[];
    relates_to: string[];
    traits: string[];
    status?: {
        maturity: "draft" | "proposed" | "stable" | "deferred" | "deprecated";
        implementation: "in_progress" | "not_started" | "implemented" | "verified";
    } | undefined;
    type?: "decision" | "task" | "module" | "feature" | "requirement" | "constraint" | "trait" | undefined;
    supersedes?: string | null | undefined;
    description?: string | undefined;
    priority?: number | "high" | "medium" | "low" | undefined;
    acceptance_criteria?: {
        id: string;
        given: string;
        when: string;
        then: string;
    }[] | undefined;
    traceability?: {
        issues?: string[] | undefined;
        implementation?: {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }[] | undefined;
        tests?: {
            path: string;
        }[] | undefined;
        commits?: string[] | undefined;
    } | undefined;
    created?: string | undefined;
    created_by?: string | undefined;
    deprecated_in?: string | null | undefined;
    superseded_by?: string | null | undefined;
    verified_at?: string | undefined;
    verified_by?: string | undefined;
}, {
    _ulid: string;
    title: string;
    status?: {
        maturity?: "draft" | "proposed" | "stable" | "deferred" | "deprecated" | undefined;
        implementation?: "in_progress" | "not_started" | "implemented" | "verified" | undefined;
    } | undefined;
    type?: "decision" | "task" | "module" | "feature" | "requirement" | "constraint" | "trait" | undefined;
    supersedes?: string | null | undefined;
    slugs?: string[] | undefined;
    description?: string | undefined;
    depends_on?: string[] | undefined;
    priority?: number | "high" | "medium" | "low" | undefined;
    tags?: string[] | undefined;
    notes?: {
        _ulid: string;
        created_at: string;
        content: string;
        author?: string | undefined;
        supersedes?: string | null | undefined;
    }[] | undefined;
    tests?: string[] | undefined;
    acceptance_criteria?: {
        id: string;
        given: string;
        when: string;
        then: string;
    }[] | undefined;
    implements?: string[] | undefined;
    relates_to?: string[] | undefined;
    traits?: string[] | undefined;
    traceability?: {
        issues?: string[] | undefined;
        implementation?: {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }[] | undefined;
        tests?: {
            path: string;
        }[] | undefined;
        commits?: string[] | undefined;
    } | undefined;
    created?: string | undefined;
    created_by?: string | undefined;
    deprecated_in?: string | null | undefined;
    superseded_by?: string | null | undefined;
    verified_at?: string | undefined;
    verified_by?: string | undefined;
}>;
/**
 * Spec item input schema (for creating new items, ULID auto-generated)
 */
export declare const SpecItemInputSchema: z.ZodObject<Omit<{
    _ulid: z.ZodString;
    slugs: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    title: z.ZodString;
    type: z.ZodOptional<z.ZodEnum<["module", "feature", "requirement", "constraint", "decision", "task", "trait"]>>;
    status: z.ZodOptional<z.ZodObject<{
        maturity: z.ZodDefault<z.ZodEnum<["draft", "proposed", "stable", "deferred", "deprecated"]>>;
        implementation: z.ZodDefault<z.ZodEnum<["not_started", "in_progress", "implemented", "verified"]>>;
    }, "strip", z.ZodTypeAny, {
        maturity: "draft" | "proposed" | "stable" | "deferred" | "deprecated";
        implementation: "in_progress" | "not_started" | "implemented" | "verified";
    }, {
        maturity?: "draft" | "proposed" | "stable" | "deferred" | "deprecated" | undefined;
        implementation?: "in_progress" | "not_started" | "implemented" | "verified" | undefined;
    }>>;
    priority: z.ZodOptional<z.ZodUnion<[z.ZodEnum<["high", "medium", "low"]>, z.ZodNumber]>>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    description: z.ZodOptional<z.ZodString>;
    acceptance_criteria: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        given: z.ZodString;
        when: z.ZodString;
        then: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        given: string;
        when: string;
        then: string;
    }, {
        id: string;
        given: string;
        when: string;
        then: string;
    }>, "many">>;
    depends_on: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    implements: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    relates_to: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    tests: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    traits: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    supersedes: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    traceability: z.ZodOptional<z.ZodObject<{
        implementation: z.ZodOptional<z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            function: z.ZodOptional<z.ZodString>;
            lines: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }, {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }>, "many">>;
        tests: z.ZodOptional<z.ZodArray<z.ZodObject<{
            path: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            path: string;
        }, {
            path: string;
        }>, "many">>;
        commits: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        issues: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        issues?: string[] | undefined;
        implementation?: {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }[] | undefined;
        tests?: {
            path: string;
        }[] | undefined;
        commits?: string[] | undefined;
    }, {
        issues?: string[] | undefined;
        implementation?: {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }[] | undefined;
        tests?: {
            path: string;
        }[] | undefined;
        commits?: string[] | undefined;
    }>>;
    created: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>;
    created_by: z.ZodOptional<z.ZodString>;
    deprecated_in: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    superseded_by: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    verified_at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>;
    verified_by: z.ZodOptional<z.ZodString>;
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
}, "_ulid"> & {
    _ulid: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    slugs: string[];
    title: string;
    depends_on: string[];
    tags: string[];
    notes: {
        _ulid: string;
        created_at: string;
        content: string;
        author?: string | undefined;
        supersedes?: string | null | undefined;
    }[];
    tests: string[];
    implements: string[];
    relates_to: string[];
    traits: string[];
    status?: {
        maturity: "draft" | "proposed" | "stable" | "deferred" | "deprecated";
        implementation: "in_progress" | "not_started" | "implemented" | "verified";
    } | undefined;
    type?: "decision" | "task" | "module" | "feature" | "requirement" | "constraint" | "trait" | undefined;
    _ulid?: string | undefined;
    supersedes?: string | null | undefined;
    description?: string | undefined;
    priority?: number | "high" | "medium" | "low" | undefined;
    acceptance_criteria?: {
        id: string;
        given: string;
        when: string;
        then: string;
    }[] | undefined;
    traceability?: {
        issues?: string[] | undefined;
        implementation?: {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }[] | undefined;
        tests?: {
            path: string;
        }[] | undefined;
        commits?: string[] | undefined;
    } | undefined;
    created?: string | undefined;
    created_by?: string | undefined;
    deprecated_in?: string | null | undefined;
    superseded_by?: string | null | undefined;
    verified_at?: string | undefined;
    verified_by?: string | undefined;
}, {
    title: string;
    status?: {
        maturity?: "draft" | "proposed" | "stable" | "deferred" | "deprecated" | undefined;
        implementation?: "in_progress" | "not_started" | "implemented" | "verified" | undefined;
    } | undefined;
    type?: "decision" | "task" | "module" | "feature" | "requirement" | "constraint" | "trait" | undefined;
    _ulid?: string | undefined;
    supersedes?: string | null | undefined;
    slugs?: string[] | undefined;
    description?: string | undefined;
    depends_on?: string[] | undefined;
    priority?: number | "high" | "medium" | "low" | undefined;
    tags?: string[] | undefined;
    notes?: {
        _ulid: string;
        created_at: string;
        content: string;
        author?: string | undefined;
        supersedes?: string | null | undefined;
    }[] | undefined;
    tests?: string[] | undefined;
    acceptance_criteria?: {
        id: string;
        given: string;
        when: string;
        then: string;
    }[] | undefined;
    implements?: string[] | undefined;
    relates_to?: string[] | undefined;
    traits?: string[] | undefined;
    traceability?: {
        issues?: string[] | undefined;
        implementation?: {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }[] | undefined;
        tests?: {
            path: string;
        }[] | undefined;
        commits?: string[] | undefined;
    } | undefined;
    created?: string | undefined;
    created_by?: string | undefined;
    deprecated_in?: string | null | undefined;
    superseded_by?: string | null | undefined;
    verified_at?: string | undefined;
    verified_by?: string | undefined;
}>;
/**
 * Spec item patch schema (partial fields, passthrough for unknown)
 * Used by `kspec item patch` for JSON updates
 */
export declare const SpecItemPatchSchema: z.ZodObject<{
    status: z.ZodOptional<z.ZodOptional<z.ZodObject<{
        maturity: z.ZodDefault<z.ZodEnum<["draft", "proposed", "stable", "deferred", "deprecated"]>>;
        implementation: z.ZodDefault<z.ZodEnum<["not_started", "in_progress", "implemented", "verified"]>>;
    }, "strip", z.ZodTypeAny, {
        maturity: "draft" | "proposed" | "stable" | "deferred" | "deprecated";
        implementation: "in_progress" | "not_started" | "implemented" | "verified";
    }, {
        maturity?: "draft" | "proposed" | "stable" | "deferred" | "deprecated" | undefined;
        implementation?: "in_progress" | "not_started" | "implemented" | "verified" | undefined;
    }>>>;
    type: z.ZodOptional<z.ZodOptional<z.ZodEnum<["module", "feature", "requirement", "constraint", "decision", "task", "trait"]>>>;
    supersedes: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    slugs: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    depends_on: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    priority: z.ZodOptional<z.ZodOptional<z.ZodUnion<[z.ZodEnum<["high", "medium", "low"]>, z.ZodNumber]>>>;
    tags: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    notes: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodObject<{
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
    }>, "many">>>;
    tests: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    acceptance_criteria: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        given: z.ZodString;
        when: z.ZodString;
        then: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        given: string;
        when: string;
        then: string;
    }, {
        id: string;
        given: string;
        when: string;
        then: string;
    }>, "many">>>;
    implements: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    relates_to: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    traits: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    traceability: z.ZodOptional<z.ZodOptional<z.ZodObject<{
        implementation: z.ZodOptional<z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            function: z.ZodOptional<z.ZodString>;
            lines: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }, {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }>, "many">>;
        tests: z.ZodOptional<z.ZodArray<z.ZodObject<{
            path: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            path: string;
        }, {
            path: string;
        }>, "many">>;
        commits: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        issues: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        issues?: string[] | undefined;
        implementation?: {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }[] | undefined;
        tests?: {
            path: string;
        }[] | undefined;
        commits?: string[] | undefined;
    }, {
        issues?: string[] | undefined;
        implementation?: {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }[] | undefined;
        tests?: {
            path: string;
        }[] | undefined;
        commits?: string[] | undefined;
    }>>>;
    created: z.ZodOptional<z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>>;
    created_by: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    deprecated_in: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    superseded_by: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    verified_at: z.ZodOptional<z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>>;
    verified_by: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    _ulid: z.ZodOptional<z.ZodOptional<z.ZodString>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    status: z.ZodOptional<z.ZodOptional<z.ZodObject<{
        maturity: z.ZodDefault<z.ZodEnum<["draft", "proposed", "stable", "deferred", "deprecated"]>>;
        implementation: z.ZodDefault<z.ZodEnum<["not_started", "in_progress", "implemented", "verified"]>>;
    }, "strip", z.ZodTypeAny, {
        maturity: "draft" | "proposed" | "stable" | "deferred" | "deprecated";
        implementation: "in_progress" | "not_started" | "implemented" | "verified";
    }, {
        maturity?: "draft" | "proposed" | "stable" | "deferred" | "deprecated" | undefined;
        implementation?: "in_progress" | "not_started" | "implemented" | "verified" | undefined;
    }>>>;
    type: z.ZodOptional<z.ZodOptional<z.ZodEnum<["module", "feature", "requirement", "constraint", "decision", "task", "trait"]>>>;
    supersedes: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    slugs: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    depends_on: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    priority: z.ZodOptional<z.ZodOptional<z.ZodUnion<[z.ZodEnum<["high", "medium", "low"]>, z.ZodNumber]>>>;
    tags: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    notes: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodObject<{
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
    }>, "many">>>;
    tests: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    acceptance_criteria: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        given: z.ZodString;
        when: z.ZodString;
        then: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        given: string;
        when: string;
        then: string;
    }, {
        id: string;
        given: string;
        when: string;
        then: string;
    }>, "many">>>;
    implements: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    relates_to: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    traits: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    traceability: z.ZodOptional<z.ZodOptional<z.ZodObject<{
        implementation: z.ZodOptional<z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            function: z.ZodOptional<z.ZodString>;
            lines: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }, {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }>, "many">>;
        tests: z.ZodOptional<z.ZodArray<z.ZodObject<{
            path: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            path: string;
        }, {
            path: string;
        }>, "many">>;
        commits: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        issues: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        issues?: string[] | undefined;
        implementation?: {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }[] | undefined;
        tests?: {
            path: string;
        }[] | undefined;
        commits?: string[] | undefined;
    }, {
        issues?: string[] | undefined;
        implementation?: {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }[] | undefined;
        tests?: {
            path: string;
        }[] | undefined;
        commits?: string[] | undefined;
    }>>>;
    created: z.ZodOptional<z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>>;
    created_by: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    deprecated_in: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    superseded_by: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    verified_at: z.ZodOptional<z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>>;
    verified_by: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    _ulid: z.ZodOptional<z.ZodOptional<z.ZodString>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    status: z.ZodOptional<z.ZodOptional<z.ZodObject<{
        maturity: z.ZodDefault<z.ZodEnum<["draft", "proposed", "stable", "deferred", "deprecated"]>>;
        implementation: z.ZodDefault<z.ZodEnum<["not_started", "in_progress", "implemented", "verified"]>>;
    }, "strip", z.ZodTypeAny, {
        maturity: "draft" | "proposed" | "stable" | "deferred" | "deprecated";
        implementation: "in_progress" | "not_started" | "implemented" | "verified";
    }, {
        maturity?: "draft" | "proposed" | "stable" | "deferred" | "deprecated" | undefined;
        implementation?: "in_progress" | "not_started" | "implemented" | "verified" | undefined;
    }>>>;
    type: z.ZodOptional<z.ZodOptional<z.ZodEnum<["module", "feature", "requirement", "constraint", "decision", "task", "trait"]>>>;
    supersedes: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    slugs: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    title: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    depends_on: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    priority: z.ZodOptional<z.ZodOptional<z.ZodUnion<[z.ZodEnum<["high", "medium", "low"]>, z.ZodNumber]>>>;
    tags: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    notes: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodObject<{
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
    }>, "many">>>;
    tests: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    acceptance_criteria: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        given: z.ZodString;
        when: z.ZodString;
        then: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        given: string;
        when: string;
        then: string;
    }, {
        id: string;
        given: string;
        when: string;
        then: string;
    }>, "many">>>;
    implements: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    relates_to: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    traits: z.ZodOptional<z.ZodDefault<z.ZodArray<z.ZodString, "many">>>;
    traceability: z.ZodOptional<z.ZodOptional<z.ZodObject<{
        implementation: z.ZodOptional<z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            function: z.ZodOptional<z.ZodString>;
            lines: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }, {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }>, "many">>;
        tests: z.ZodOptional<z.ZodArray<z.ZodObject<{
            path: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            path: string;
        }, {
            path: string;
        }>, "many">>;
        commits: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        issues: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        issues?: string[] | undefined;
        implementation?: {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }[] | undefined;
        tests?: {
            path: string;
        }[] | undefined;
        commits?: string[] | undefined;
    }, {
        issues?: string[] | undefined;
        implementation?: {
            path: string;
            function?: string | undefined;
            lines?: string | undefined;
        }[] | undefined;
        tests?: {
            path: string;
        }[] | undefined;
        commits?: string[] | undefined;
    }>>>;
    created: z.ZodOptional<z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>>;
    created_by: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    deprecated_in: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    superseded_by: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    verified_at: z.ZodOptional<z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>>;
    verified_by: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    _ulid: z.ZodOptional<z.ZodOptional<z.ZodString>>;
}, z.ZodTypeAny, "passthrough">>;
/**
 * Root manifest schema
 */
export declare const ManifestSchema: z.ZodObject<{
    kynetic: z.ZodDefault<z.ZodString>;
    project: z.ZodObject<{
        name: z.ZodString;
        version: z.ZodDefault<z.ZodString>;
        status: z.ZodDefault<z.ZodEnum<["draft", "proposed", "stable", "deferred", "deprecated"]>>;
    }, "strip", z.ZodTypeAny, {
        status: "draft" | "proposed" | "stable" | "deferred" | "deprecated";
        name: string;
        version: string;
    }, {
        name: string;
        status?: "draft" | "proposed" | "stable" | "deferred" | "deprecated" | undefined;
        version?: string | undefined;
    }>;
    modules: z.ZodOptional<z.ZodArray<z.ZodAny, "many">>;
    features: z.ZodOptional<z.ZodArray<z.ZodAny, "many">>;
    requirements: z.ZodOptional<z.ZodArray<z.ZodAny, "many">>;
    constraints: z.ZodOptional<z.ZodArray<z.ZodAny, "many">>;
    decisions: z.ZodOptional<z.ZodArray<z.ZodAny, "many">>;
    traits: z.ZodOptional<z.ZodArray<z.ZodAny, "many">>;
    includes: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    hooks: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    kynetic: string;
    project: {
        status: "draft" | "proposed" | "stable" | "deferred" | "deprecated";
        name: string;
        version: string;
    };
    includes?: string[] | undefined;
    traits?: any[] | undefined;
    modules?: any[] | undefined;
    features?: any[] | undefined;
    requirements?: any[] | undefined;
    constraints?: any[] | undefined;
    decisions?: any[] | undefined;
    hooks?: Record<string, string> | undefined;
}, {
    project: {
        name: string;
        status?: "draft" | "proposed" | "stable" | "deferred" | "deprecated" | undefined;
        version?: string | undefined;
    };
    includes?: string[] | undefined;
    traits?: any[] | undefined;
    kynetic?: string | undefined;
    modules?: any[] | undefined;
    features?: any[] | undefined;
    requirements?: any[] | undefined;
    constraints?: any[] | undefined;
    decisions?: any[] | undefined;
    hooks?: Record<string, string> | undefined;
}>;
export type Status = z.infer<typeof StatusSchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type ImplementationRef = z.infer<typeof ImplementationRefSchema>;
export type Traceability = z.infer<typeof TraceabilitySchema>;
export type SpecItem = z.infer<typeof SpecItemSchema>;
export type SpecItemInput = z.infer<typeof SpecItemInputSchema>;
export type SpecItemPatch = z.infer<typeof SpecItemPatchSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
//# sourceMappingURL=spec.d.ts.map