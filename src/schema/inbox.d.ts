import { z } from "zod";
/**
 * Inbox item - low-friction capture for ideas that aren't tasks yet.
 * Intentionally simple: just text, timestamp, optional tags, and who added it.
 */
export declare const InboxItemSchema: z.ZodObject<{
    _ulid: z.ZodString;
    text: z.ZodString;
    created_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    added_by: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    _ulid: string;
    created_at: string;
    text: string;
    tags: string[];
    added_by?: string | undefined;
}, {
    _ulid: string;
    created_at: string;
    text: string;
    added_by?: string | undefined;
    tags?: string[] | undefined;
}>;
/**
 * Inbox item input schema (for creating new items)
 */
export declare const InboxItemInputSchema: z.ZodObject<{
    _ulid: z.ZodOptional<z.ZodString>;
    text: z.ZodString;
    created_at: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodString]>>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    added_by: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    text: string;
    _ulid?: string | undefined;
    created_at?: string | undefined;
    added_by?: string | undefined;
    tags?: string[] | undefined;
}, {
    text: string;
    _ulid?: string | undefined;
    created_at?: string | undefined;
    added_by?: string | undefined;
    tags?: string[] | undefined;
}>;
/**
 * Inbox file schema (collection of inbox items)
 */
export declare const InboxFileSchema: z.ZodObject<{
    inbox: z.ZodArray<z.ZodObject<{
        _ulid: z.ZodString;
        text: z.ZodString;
        created_at: z.ZodUnion<[z.ZodString, z.ZodString]>;
        tags: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        added_by: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        _ulid: string;
        created_at: string;
        text: string;
        tags: string[];
        added_by?: string | undefined;
    }, {
        _ulid: string;
        created_at: string;
        text: string;
        added_by?: string | undefined;
        tags?: string[] | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    inbox: {
        _ulid: string;
        created_at: string;
        text: string;
        tags: string[];
        added_by?: string | undefined;
    }[];
}, {
    inbox: {
        _ulid: string;
        created_at: string;
        text: string;
        added_by?: string | undefined;
        tags?: string[] | undefined;
    }[];
}>;
export type InboxItem = z.infer<typeof InboxItemSchema>;
export type InboxItemInput = z.infer<typeof InboxItemInputSchema>;
export type InboxFile = z.infer<typeof InboxFileSchema>;
//# sourceMappingURL=inbox.d.ts.map