# Traits

Traits are reusable acceptance criteria that apply across multiple specs. Instead of copying the same requirement into every spec that needs it, you define it once as a trait and declare which specs implement it.

## Why They Exist

Some requirements cut across features. "All CLI commands with structured output support a machine-readable format" is not specific to any one command — it applies to every command that produces structured output. Without traits, you'd either duplicate that criterion in dozens of specs or leave it implicit and hope reviewers remember to check it.

Traits make cross-cutting requirements explicit and auditable. When a spec declares that it implements a trait, it inherits the trait's acceptance criteria. Those inherited criteria show up during review and validation, so nothing gets overlooked.

## What a Trait Is

A trait is a special kind of spec item. Like other spec items, it carries a title, description, and acceptance criteria. The difference is in how it's used: traits aren't implemented directly. Instead, other spec items declare that they implement the trait.

For example, a trait for machine-readable output might define:

- Given a command produces output, when the user requests machine-readable format, then the output is valid structured data.
- Given the user requests machine-readable format, when the command encounters an error, then the error is also returned as structured data.

Any spec that declares it implements this trait automatically inherits these criteria. The spec's own acceptance criteria and the trait's criteria are both required for the implementation to be considered complete.

## How Traits Compose

A spec can implement multiple traits, and traits can define any number of acceptance criteria. The composition is additive: a spec's total acceptance criteria are its own plus all criteria from every trait it implements.

When you view a spec with the CLI, inherited trait criteria are shown alongside the spec's own criteria, with a note indicating which trait they come from. This makes it clear what the full set of requirements is without jumping between files.

If a trait criterion genuinely doesn't apply to a particular spec, you annotate it as not applicable with a reason. This is a deliberate decision, not an omission — the annotation is machine-parseable so validation can distinguish between "covered," "not applicable," and "missing."

## How They Surface in Use

**During spec creation.** When you define a new spec, you can add traits to declare which cross-cutting requirements it should satisfy. The trait's criteria become part of the spec's contract.

**During implementation.** When working on a task, you see both the spec's own criteria and the inherited trait criteria. Each one needs a test annotated with the trait's reference, not the spec's, so the coverage tracking knows which trait is being verified.

**During review.** A reviewer checking a task can see whether all trait criteria have been addressed. The validation tooling reports uncovered trait criteria as warnings, catching gaps before they reach production.

**During evolution.** When you add a new criterion to a trait, every spec that implements it gains that requirement. This is intentional — traits let you raise the bar across the project with a single change. It also means trait changes should be deliberate, since they have wide impact.
