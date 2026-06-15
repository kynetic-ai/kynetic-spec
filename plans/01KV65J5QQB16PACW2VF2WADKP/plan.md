# Formal Specification Sidecars for kspec

Generated: 2026-06-15  
Scope: draft investigation / planning note only; no specs, tasks, or `.kspec` state changes.  
Purpose: preserve the research, tradeoff analysis, and integration model for using formal languages with kspec so the idea can be picked up later.

## Question

How could kspec use a formal language such as Lean, TLA+, Alloy, Dafny/F*, or Cedar-adjacent policy modeling to make important specification semantics mechanically checkable without replacing kspec's current human/product workflow?

The specific motivating example used here is **review snapshot binding**:

> A review approval should authorize only the exact subject snapshot that was reviewed. If the subject content changes afterward, the prior approval should become stale and should not authorize completion, merge, or dispatch progression.

## Short conclusion

The most promising direction is **not** a wholesale migration from kspec YAML/prose into a theorem prover. kspec should remain the durable workflow layer for human intent, plans, tasks, reviews, dispatch, traceability, and closure.

Formal methods fit best as **sidecars** attached to narrow, high-value invariant families where prose review and local tests are likely to miss global semantic drift.

Recommended shape:

```yaml
formal:
  language: lean4 # or tla+, alloy, dafny, fstar, cedar
  artifact: formal/Kspec/ReviewSnapshot.lean
  checks:
    - hash_changed_invalidates_approval
    - completion_requires_current_approval
  required_for_changes: true
```

The formal sidecar becomes an architectural contract artifact:

```text
kspec prose/spec intent
  -> formal model and proof/check
  -> implementation conformance tests
  -> review gate and agent instructions
```

## Research notes

### Video thesis

The referenced video's relevant claim is that AI agents are often good at satisfying local implementation requests but weaker at preserving global architectural distinctions over time. A formal model can force those distinctions to be named, compiled, and reviewed.

The useful pattern is:

1. Identify a domain distinction agents might blur.
2. Encode that distinction in a small formal model.
3. Prove or check the invariant that should never drift.
4. Require agents and reviewers to keep the formal model, implementation, and tests aligned.

The important lesson is not “write every spec in Lean.” It is:

> Move the small set of architecture-critical semantics into a compiled artifact that fails loudly when the semantics are weakened.

### Language fit

#### Lean

Lean is a theorem prover and functional programming language based on dependent type theory. It is strongest when the goal is to define precise domain concepts and prove semantic invariants about them.

Good kspec fit:

- review snapshot binding;
- task lifecycle invariants;
- canonical identity semantics;
- coverage semantics;
- proof-carrying architecture distinctions agents might otherwise collapse.

Weaknesses:

- steep learning curve;
- proof maintenance cost;
- not automatically connected to TypeScript/Rust implementation;
- easy to create proof theater if the model is too abstract or vacuous.

Lean proves properties of the **model**. Additional tests or generated checks are still needed to show the implementation conforms to the model.

#### TLA+

TLA+ is strongest for lifecycle, concurrency, and state-machine behavior. It is useful when the important question is “can this bad state become reachable through some sequence of transitions?”

Good kspec fit:

- task/review lifecycle;
- dispatch state transitions;
- retry, stale review, and merge progression behavior;
- concurrency or interleaving problems.

Weaknesses:

- less natural for type-level domain modeling;
- model checking explores a modeled state space, so abstractions and bounds matter;
- results are only as good as the transition model.

#### Alloy

Alloy is strongest for relational/data-model constraints and bounded counterexample finding.

Good kspec fit:

- ref graphs;
- aliases vs canonical IDs;
- dependency graph constraints;
- “there must not exist two active invocations for the same canonical task”;
- coverage/relationship consistency.

Weaknesses:

- bounded analysis is not a universal proof;
- the model may need careful scoping to avoid false confidence.

#### Dafny / F*

Dafny and F* are better fits when the desired artifact is implementation-adjacent verified code: algorithms with specs and proofs that can be compiled or extracted.

Good kspec fit:

- small pure algorithms where executable verified code would matter;
- canonicalization routines;
- hash/snapshot comparison utilities;
- graph validation algorithms.

Weaknesses:

- larger adoption cost than sidecar-only models;
- may force implementation architecture choices earlier than desired.

#### Cedar

Cedar is a formal authorization policy language. It is good at representing and evaluating policy decisions over principals, actions, resources, and context. It is not a general replacement for kspec specs.

Good kspec-adjacent fit:

- authorization policy decisions;
- schema-validated policy inputs;
- permit/forbid rules;
- auditability around access-control behavior.

Weaknesses:

- not a theorem prover for arbitrary kspec semantics;
- not a natural representation for task lifecycle, review binding, or dispatch identity invariants;
- best treated as a specialized policy sidecar, not the general formal language for kspec.

## Why not a full switch?

A wholesale switch from kspec to Lean or another formal language would require replatforming far more than the textual spec representation:

- spec corpus format;
- plan import/export;
- task derivation;
- review storage and display;
- dispatch prompt generation;
- UI editing and rendering;
- search and ref workflows;
- coverage mapping;
- agent instructions;
- migration of existing specs, tasks, reviews, and plans;
- reviewer training and proof review standards.

It would also risk making ordinary product/spec changes require proof-engineering work. That is likely too much friction for most kspec behavior.

The sidecar approach keeps the cost proportional:

- only formalize high-value invariants;
- keep normal specs readable and editable;
- make formal checks mandatory only for specs that opt into them;
- use implementation tests to bridge formal models to real code.

## Proposed integration model

### Repository layout

A kspec project could contain a dedicated formal project:

```text
formal/
  lakefile.lean
  Kspec/
    ReviewSnapshot.lean
    TaskLifecycle.lean
    DispatchIdentity.lean
scripts/
  check-formal.sh
tests/
  review-snapshot-binding.test.ts
```

For non-Lean sidecars, the layout could include sibling folders:

```text
formal/
  lean/
  tla/
  alloy/
  cedar/
```

The exact layout matters less than three properties:

1. artifacts are close to the kspec project;
2. specs can link to artifacts and named checks;
3. agents/reviewers have a deterministic gate command.

### Spec metadata

A spec item with formal coverage could carry metadata like:

```yaml
formal:
  language: lean4
  artifact: formal/Kspec/ReviewSnapshot.lean
  checks:
    - hash_changed_invalidates_approval
    - completion_requires_current_approval
  required_for_changes: true
```

Possible validation behavior later:

- warn if the referenced artifact is missing;
- warn if a listed check name is not found;
- warn/error if a task changes a formalized AC but does not record formal gate evidence;
- include formal sidecar instructions in dispatch prompts for tasks covering that spec.

This can start as a review convention before becoming a validator feature.

### Gate command

A minimal Lean gate could be:

```bash
#!/usr/bin/env bash
set -euo pipefail

cd formal
lake build

if grep -R "\bsorry\b" Kspec; then
  echo "Formal proof contains sorry"
  exit 1
fi

if grep -R "\baxiom\b" Kspec; then
  echo "Formal proof contains unchecked axiom"
  exit 1
fi
```

For a real implementation, the gate should probably be wrapped as:

```bash
scripts/check-formal.sh
```

so dispatch prompts and reviewers do not need to know each tool's exact invocation.

### Dispatch prompt augmentation

When a task covers a spec with `formal.required_for_changes: true`, the generated agent prompt should include something like:

```text
Formal sidecar required:
- formal/Kspec/ReviewSnapshot.lean
- Required checks:
  - hash_changed_invalidates_approval
  - completion_requires_current_approval

Instructions:
1. Read the formal artifact before editing implementation.
2. Preserve or intentionally update the formal checks if behavior changes.
3. Add or update implementation tests that mirror the formal invariant.
4. Run scripts/check-formal.sh before submission.
5. In the final report, map changed implementation paths to the formal concepts they enforce.
```

This is important because the formal model is not just another test. It is part of the task context.

## Review snapshot binding example

### Human kspec intent

The plain-language rule:

> A review approval authorizes only the exact subject snapshot that was reviewed. If a subject has the same ref but different content hash, the old approval is stale and cannot approve the changed subject.

The key distinction is:

```text
same subject ref != same reviewed subject snapshot
```

Agents are likely to blur that distinction if the code or prompt only says “approved review for this task.” The formal sidecar forces the distinction to be represented directly.

### Lean model sketch

Illustrative Lean-like model:

```lean
namespace Kspec.ReviewSnapshot

abbrev Ref := String
abbrev Hash := String

inductive Verdict where
  | approved
  | rejected
  | changesRequested
deriving DecidableEq, Repr

structure Subject where
  ref : Ref
  contentHash : Hash
deriving Repr

structure Review where
  subjectRef : Ref
  boundHash : Hash
  verdict : Verdict
deriving Repr

def ReviewBindsSubject (r : Review) (s : Subject) : Prop :=
  r.subjectRef = s.ref ∧ r.boundHash = s.contentHash

def ReviewApprovesSubject (r : Review) (s : Subject) : Prop :=
  r.verdict = Verdict.approved ∧ ReviewBindsSubject r s

theorem hash_changed_invalidates_approval
  (r : Review)
  (oldSubject newSubject : Subject)
  (approvedOld : ReviewApprovesSubject r oldSubject)
  (sameRef : oldSubject.ref = newSubject.ref)
  (hashChanged : oldSubject.contentHash ≠ newSubject.contentHash) :
  ¬ ReviewApprovesSubject r newSubject := by
  intro approvedNew

  have oldBound : r.boundHash = oldSubject.contentHash :=
    approvedOld.right.right

  have newBound : r.boundHash = newSubject.contentHash :=
    approvedNew.right.right

  have hashesEqual : oldSubject.contentHash = newSubject.contentHash := by
    calc
      oldSubject.contentHash = r.boundHash := Eq.symm oldBound
      _ = newSubject.contentHash := newBound

  exact hashChanged hashesEqual

end Kspec.ReviewSnapshot
```

What this proves:

> If a review approved an old subject snapshot, and the current subject has the same ref but a different content hash, then the review does not approve the current subject.

What this does **not** prove by itself:

- that the implementation computes the same content hash;
- that the implementation stores the bound hash correctly;
- that completion/merge/dispatch code calls the right predicate;
- that all relevant subject types are included;
- that the UI displays stale review state correctly.

Those require implementation conformance checks.

### Implementation mapping

A corresponding implementation predicate might look like:

```ts
function reviewApprovesSubject(review: Review, subject: Subject): boolean {
  return (
    review.verdict === "approved" &&
    review.subjectRef === subject.ref &&
    review.boundHash === subject.contentHash
  );
}
```

The mapping to the formal model should be explicit in reviews:

| Formal concept | Implementation concept |
| --- | --- |
| `Subject.ref` | task/spec/plan/review subject ref |
| `Subject.contentHash` | current canonical subject snapshot hash |
| `Review.subjectRef` | review's bound subject ref |
| `Review.boundHash` | review's stored reviewed snapshot hash |
| `ReviewApprovesSubject` | implementation predicate used before completion/merge/progression |

### Conformance test shape

A focused test should mirror the theorem:

```ts
it("does not allow a review approval to authorize a changed subject hash", () => {
  const oldSubject = {
    ref: "@task-123",
    contentHash: "hash-old",
  };

  const newSubject = {
    ref: "@task-123",
    contentHash: "hash-new",
  };

  const review = {
    subjectRef: "@task-123",
    boundHash: "hash-old",
    verdict: "approved",
  };

  expect(reviewApprovesSubject(review, oldSubject)).toBe(true);
  expect(reviewApprovesSubject(review, newSubject)).toBe(false);
});
```

Stronger conformance could use property-based tests:

```ts
fc.assert(
  fc.property(reviewArb, oldSubjectArb, changedSubjectArb, (review, oldSubject, newSubject) => {
    // If review approves oldSubject and newSubject has the same ref but changed hash,
    // reviewApprovesSubject(review, newSubject) must be false.
  })
);
```

### What agents would do

For an implementation task affecting review snapshot binding, the expected agent loop would be:

1. Read the kspec item and see the `formal` metadata.
2. Read the formal artifact before editing code.
3. Identify which implementation concepts correspond to the formal concepts.
4. Change implementation behavior.
5. Add or update conformance tests mirroring the formal theorem.
6. Run the formal gate.
7. Run focused implementation tests.
8. Run normal kspec validation.
9. Report both gate output and model-to-code mapping.

The final report should not merely say “tests pass.” It should include a mapping such as:

```text
Formal mapping:
- Review.boundHash corresponds to stored review snapshot hash.
- Subject.contentHash corresponds to the current canonical task snapshot hash.
- canCompleteTask now requires ReviewApprovesSubject-equivalent logic.

Evidence:
- scripts/check-formal.sh passed.
- focused stale-review test passed.
- kspec validate --warnings-ok passed.
```

### What reviewers would do

Reviewers need to check four layers:

1. **Model adequacy**
   - Does the formal model capture the intended product rule?
   - Is the chosen hash the right binding surface?
   - Are all relevant subject types included or intentionally abstracted?

2. **Theorem/check meaningfulness**
   - Does the theorem prove a drift-prone invariant?
   - Or is it merely restating a definition with no product value?

3. **Proof hygiene**
   - No `sorry`.
   - No unchecked `axiom`.
   - No unsafe or overly broad assumptions.
   - For TLA+/Alloy, scopes and bounds are explicit and not oversold.

4. **Implementation conformance**
   - Does real code enforce the same predicate?
   - Are tests mapped to the formal invariant?
   - Are there bypass paths where completion/merge/progression can occur without the predicate?

A formal build passing is necessary evidence, not sufficient evidence.

## Proof levels

There are several levels of rigor available. They should not be confused.

### Level 1: formal model proof

Lean proves a theorem about the abstract model.

Claim supported:

> Within this model, changed hashes invalidate review approval.

This is useful but abstract.

### Level 2: implementation conformance tests

Normal tests show concrete implementation cases obey the model.

Claim supported:

> This implementation path behaves like the formal rule for these tested cases.

This is practical and should be the first bridge.

### Level 3: property/differential testing

Property-based tests generate many cases shaped like the theorem.

Claim supported:

> Across many generated cases, the implementation behaves like the model.

This is stronger and still practical for small pure predicates.

### Level 4: verified implementation

The implementation itself is written, extracted, or proven in a verification-aware language.

Claim supported:

> The executable implementation has machine-checked correspondence to its specification.

This is the highest-rigor path and likely too expensive for an initial kspec exploration.

## Future behavior-change example

Suppose kspec later decides that comment-only changes should not invalidate review approval. The formal model forces that decision to become precise.

Instead of binding review approval to raw `contentHash`, the model might introduce separate hashes:

```lean
structure Subject where
  ref : Ref
  semanticHash : Hash
  displayHash : Hash
```

Then approval might bind to `semanticHash`:

```lean
def ReviewBindsSubject (r : Review) (s : Subject) : Prop :=
  r.subjectRef = s.ref ∧ r.boundSemanticHash = s.semanticHash
```

The implementation would then need to compute and persist a canonical semantic hash, tests would need to distinguish semantic vs display-only changes, and reviewers would have a concrete architecture question to answer:

> Is the review approval intended to bind to raw content, semantic content, rendered display, or something else?

That is the main value of the formal sidecar: it makes semantic changes explicit instead of allowing accidental drift.

## Other promising kspec invariant families

The review snapshot binding example is only one possible sidecar. Other high-value candidates:

### Task lifecycle

Potential invariant:

> A task cannot become completed unless the current task snapshot has an approved review bound to that exact snapshot.

Likely best fit:

- Lean if the concern is semantic definition;
- TLA+ if the concern is reachable lifecycle states.

### Dispatch canonical identity

Potential invariant:

> Scheduler identity is canonical task ID. Slugs and raw refs are display/input aliases only and cannot define active/in-flight identity.

Likely best fit:

- Alloy for relational counterexamples;
- Lean for exact canonicalization semantics;
- implementation property tests for alias behavior.

### Coverage semantics

Potential invariant:

> Corpus-level acceptance criteria remain coverable. Task-scoped not-applicable metadata does not exempt corpus coverage.

Likely best fit:

- Lean for semantic rules;
- Alloy for relationships among specs, ACs, tasks, and coverage records.

### Workflow/review dependency behavior

Potential invariant:

> A dependent review/merge/progression action cannot observe a stale predecessor state as current.

Likely best fit:

- TLA+ for lifecycle and interleaving;
- implementation tests for state transitions.

### Authorization policy surfaces

Potential invariant class:

> Policy decisions over principal/action/resource/context remain explicit, schema-validated, and fail closed.

Likely best fit:

- Cedar for policy rules and schema;
- implementation tests for integration and fail-closed behavior;
- Lean/TLA+/Alloy only if surrounding lifecycle or semantic invariants exceed Cedar's policy-decision scope.

## Wider research: how others use formal specs with code

This section captures public examples and patterns worth considering before choosing a kspec-specific approach. The examples span proof assistants, model checkers, SMT-backed policy analysis, differential testing, trace validation, and verified implementation.

### AWS TLA+: formal specs as design-debugging artifacts

Sources:

- https://cacm.acm.org/research/how-amazon-web-services-uses-formal-methods/
- https://www.infoq.com/presentations/aws-testing-tla/
- https://www.youtube.com/watch?v=HxP4wi4DhA0

AWS has used TLA+ and PlusCal for distributed-system design checking across systems such as S3 and DynamoDB. The useful framing is not “academic proof” but “debugging designs” or “exhaustively testable pseudo-code.” TLA+ is used to model high-level behavior, define safety/liveness properties, and use TLC to search possible executions for counterexamples.

Notable lessons:

- Formal specs are valuable even when they do not generate production code.
- They can find multi-step design failures that tests and reviews miss.
- They are especially good for concurrency, replication, migration, and protocol transitions.
- The model-code gap remains: AWS explicitly notes that TLA+ does not prove the code implements the design.
- Strong invariants discovered in TLA+ can become runtime assertions, tests, or review gates.

kspec takeaway:

> Present formal sidecars as “debuggable architecture/spec models,” not as a demand that every product spec become a theorem. For lifecycle-heavy kspec behavior, TLA+ or a TLA+-like layer may be more ergonomic than Lean.

### Cedar: executable formal model plus production implementation plus differential testing

Sources:

- https://lean-lang.org/use-cases/cedar/
- https://github.com/cedar-policy/cedar-spec/tree/main/cedar-lean
- https://github.com/cedar-policy/cedar-spec/tree/main/cedar-lean-cli
- https://www.amazon.science/blog/how-we-built-cedar-with-automated-reasoning-and-differential-testing
- https://aws.amazon.com/blogs/opensource/introducing-cedar-analysis-open-source-tools-for-verifying-authorization-policies/

Cedar is one of the cleanest examples of the sidecar pattern. It keeps production Rust code and executable Lean models side by side. The Lean models describe components such as evaluation, authorization, validation, and symbolic compilation. Proofs establish important correctness/security properties, while differential testing generates many inputs and compares Lean behavior against Rust behavior.

Important pattern:

```text
production implementation
  <-> executable formal model
  <-> proofs over the model
  <-> differential/random testing between model and implementation
  <-> release gate requiring model/proofs/tests to stay current
```

kspec takeaway:

> For narrow domains, a formal sidecar should ideally be executable enough to act as a test oracle. The model should not just prove abstract theorems; it should support differential or property testing against real code where practical.

### Microsoft CCF: TLA+ specs bound to C++ implementation through trace validation

Sources:

- https://www.microsoft.com/en-us/research/publication/smart-casual-verification-of-ccfs-distributed-consensus-and-consistency-protocols/
- https://www.usenix.org/conference/nsdi25/presentation/howard
- http://ccf.dev/main/architecture/raft_tla.html
- https://github.com/microsoft/CCF/blob/main/.github/workflows/ci-verification.yml

Microsoft CCF uses a hybrid “smart casual verification” approach: formal TLA+ specs plus pragmatic automated testing. The notable integration point is that the formal specification is bound to the C++ implementation through traces and CI. The project uses model checking and trace validation to keep the spec and implementation aligned as contributors evolve the system.

Reported pattern:

- keep TLA+ models in the repository;
- run model checking in CI;
- instrument implementation behavior;
- validate implementation traces against a TLA+ trace spec;
- upload traces/counterexamples as failure artifacts.

kspec takeaway:

> A kspec sidecar should not stop at `model-check passes`. For stateful implementation areas, it should support implementation trace validation: emit semantically meaningful events, translate them into formal states/transitions, and check that observed runs are allowed by the model.

### etcd/raft: TLA+ model plus trace validation for a Go implementation

Sources:

- https://github.com/etcd-io/raft/tree/main/tla
- https://github.com/etcd-io/raft/pull/113

The etcd/raft repository includes TLA+ specifications and trace-validation machinery. The model accounts for implementation-specific behavior such as membership reconfiguration. The trace-validation flow uses build tags/logging to emit state-transition events, then validates NDJSON traces against the TLA+ model.

Notable implementation details:

- separate model-checking files from trace-validation files;
- explicit scripts for model checking and trace checking;
- trace events are logged from meaningful state transitions;
- sampled/incomplete logs are unsafe for validation;
- large traces may need batching.

kspec takeaway:

> kspec could eventually define a trace schema for formalized lifecycle areas. For example, task/review/dispatch transitions could emit compact events that are checked against a formal lifecycle sidecar.

### MongoDB replication: observed implementation traces checked against a TLA+ spec

Sources:

- https://github.com/mongodb/mongo/blob/master/src/mongo/tla_plus/Replication/RaftMongo/RaftMongo.tla
- https://github.com/mongodb-labs/repl-trace-checker

MongoDB has public TLA+ modeling around replication behavior and a trace-checking workflow. The important pattern is not only the design model, but conversion of actual execution logs into a form that can be checked against the model.

kspec takeaway:

> For an existing implementation, conformance may be best added by observing real runs rather than attempting to prove all code. This is useful for dispatch/review/session behavior where real events already exist.

### Alloy and relational counterexample finding

Sources:

- https://github.com/dgpv/miniscript-alloy-spec
- https://github.com/AlloyTools/models/blob/master/models/webattack/webattack.md
- https://github.com/hyperpolymath/alloyiser/blob/main/README.adoc

Alloy is widely useful when the core issue is relational structure: entity relationships, graph constraints, aliases, reachability, and impossible combinations. Examples include Bitcoin Miniscript modeling, web attack models, and tools that extract interface/entity relationships into Alloy.

Observed pattern:

- define a compact relational model;
- state assertions such as “there do not exist two active entities for the same canonical ID”;
- run bounded searches;
- inspect counterexample instances;
- use counterexamples as design review artifacts or generated tests.

kspec takeaway:

> Alloy is a strong candidate for kspec ref graphs, canonical identity, aliases, dependency relationships, coverage relationships, and resource ownership. It may produce useful counterexamples faster than a full theorem-prover workflow.

### Dafny / IronFleet: verified implementations through refinement

Sources:

- https://github.com/microsoft/Ironclad/tree/main/ironfleet
- https://cacm.acm.org/research/ironfleet/

IronFleet used Dafny to verify distributed systems such as a Paxos-based replicated state machine and a sharded key-value store. Its methodology combines high-level state-machine specs, refinement, Hoare-style reasoning, and executable verified code.

Lessons:

- this is a strong high-assurance path;
- it can prove much deeper implementation correspondence than sidecar-only modeling;
- the annotation/proof burden is high;
- it is probably too heavy as the default path for kspec behavior.

kspec takeaway:

> Keep verified implementation as an escalation path, not the initial target. Start with sidecars, model checking, trace validation, and conformance tests before attempting full refinement proofs.

### F* / HACL* / EverCrypt: verified libraries and generated production code

Sources:

- https://hacl-star.github.io/
- https://github.com/hacl-star/hacl-star
- https://project-everest.github.io/
- https://blog.mozilla.org/security/2020/07/06/performance-improvements-via-formally-verified-cryptography-in-firefox/

HACL* and EverCrypt use F*, Low*, and Vale to verify cryptographic code and extract/generate production C/assembly used by real downstream projects. The lesson is less “kspec should use F*” and more that formally verified components can be consumed as trusted libraries rather than reproved locally.

kspec takeaway:

> For security-critical primitives, kspec should prefer depending on existing verified libraries where possible. Formal sidecars can record assumptions and integration checks around those libraries rather than redoing the verification.

### Coq/Rocq: CompCert, Fiat-Crypto, Verdi

Sources:

- https://compcert.org/doc/
- https://github.com/mit-plv/fiat-crypto
- https://boringssl.googlesource.com/boringssl/+/HEAD/third_party/fiat/README.md
- https://github.com/uwplse/verdi
- https://github.com/uwplse/verdi-Raft

Coq/Rocq projects show several mature patterns:

- CompCert proves semantic preservation for a C compiler and extracts executable compiler code.
- Fiat-Crypto synthesizes correct-by-construction cryptographic arithmetic used by downstream production libraries.
- Verdi verifies distributed systems and fault-model transformations.

kspec takeaway:

> These are useful north-star examples for layered specs, extraction, generated code, and fault-model libraries, but they are likely too proof-heavy for ordinary kspec sidecars. Their biggest near-term value is architectural: separate abstract spec, executable/generated artifact, proof, and integration assumptions.

### Isabelle/HOL and seL4: layered high-assurance proof stacks

Sources:

- https://github.com/seL4/l4v
- https://sel4.systems/Verification/proofs.html
- https://trustworthy.systems/publications/nicta_full_text/1852.pdf

seL4 demonstrates a layered proof stack: abstract specification, executable/design specification, refinement to C, and additional security properties. It is one of the strongest real-world examples of high-assurance formal verification.

kspec takeaway:

> Do not make seL4-style proof the default expectation. But borrow the layering idea: prose/product spec, abstract formal model, implementation conformance layer, and explicit assumptions/limits.

### Lean extraction / source-to-proof pipelines

Sources:

- https://lean-lang.org/use-cases/aeneas/
- https://github.com/cryspen/hax
- https://github.com/runtimeverification/aeneas_fri_fold_arity_verification
- https://github.com/reilabs/lampe

Aeneas, Hax, and related tools extract code from languages such as Rust or Noir into Lean/F*/Rocq-style proof targets. These approaches are useful when the implementation already exists and the goal is to reason about extracted pure representations rather than rewrite code in the proof assistant.

Observed pattern:

- generate proof-side code from implementation;
- keep generated files separate from hand-written proof/spec files;
- prove properties externally over extracted definitions;
- track unsupported language features and extraction gaps explicitly.

kspec takeaway:

> If kspec later wants stronger code correspondence, generated formal sidecars from source may be better than forcing humans/agents to maintain duplicate models manually. The sidecar layout should distinguish generated files from human-owned proof/spec files.

### Lean embedded verifiers and DSLs: Veil, Velvet, `mvcgen`, `grind`

Sources:

- https://github.com/verse-lab/veil
- https://github.com/verse-lab/velvet
- https://lean-lang.org/doc/reference/latest/The--mvcgen--tactic/Overview/
- https://lean-lang.org/doc/reference/latest/The--grind--tactic/Bigger-Examples/

Lean is developing a broader software-verification ecosystem, including state-machine frameworks, Dafny-like embedded contract systems, weakest-precondition generation, and stronger automation tactics.

kspec takeaway:

> A useful kspec integration should not assume every formal artifact is a hand-written theorem from scratch. There may be value in templates or embedded DSLs that generate the proof obligations agents must satisfy.

### AI-assisted proof/spec generation

Sources:

- https://github.com/lean-dojo/BRIDGE
- https://arxiv.org/pdf/2306.15626
- https://proceedings.mlr.press/v288/song25a.html

Projects such as LeanDojo/ReProver, Lean Copilot, and BRIDGE explore AI-assisted theorem proving and code/spec/proof decomposition. The important trust boundary is that AI can propose proof steps or specs, but the Lean kernel or backend checker must validate accepted artifacts.

kspec takeaway:

> Agents can help write formal sidecars, but the artifact that matters is the checked proof/model output. Reviews should treat AI-generated proofs as normal code: inspect model adequacy, reject vacuity, and rely on the checker as the trust boundary.

### Code-level bounded verification: CBMC and Kani

Sources:

- https://github.com/aws/s2n-tls/blob/main/tests/cbmc/README.md
- https://github.com/model-checking/kani
- https://github.com/model-checking/kani-github-action

AWS s2n-tls uses CBMC proof harnesses for memory-safety checks over selected C entry points, with proofs run locally and in CI. Kani provides a similar bounded model-checking style for Rust, with GitHub Action support.

kspec takeaway:

> Formal sidecars do not need to be only “spec language” artifacts. Some invariants may be best represented as code-level proof harnesses that look like tests but quantify over all bounded inputs. kspec could record these as a formal backend/gate type.

### Quint, Apalache, and developer-friendly model checking

Sources:

- https://github.com/informalsystems/quint/
- https://quint-lang.org/
- https://github.com/apalache-mc/apalache/

Quint provides TLA-style semantics with a more developer-friendly syntax, type/effect checking, simulation, and integration with Apalache. Apalache provides bounded symbolic model checking via SMT.

kspec takeaway:

> Developer experience matters. If TLA+ is too alien for agents/reviewers, a Quint-style frontend or model-checking backend may be a better initial fit for lifecycle specs than raw TLA+.

### Deterministic simulation as a complement, not a proof

Sources:

- https://www.youtube.com/watch?v=4fFDFbi3toc
- https://www.youtube.com/watch?v=IaB8jvjW0kk

FoundationDB-style deterministic simulation is not formal proof, but it is highly relevant to closing the model-code gap. It can replay failures, inject faults, and exercise real implementation code under controlled schedules.

kspec takeaway:

> Formal sidecars should be paired with deterministic replay, property tests, fuzzing, or simulation where the implementation is too complex to verify directly. Formal models can generate scenarios; simulation can validate real behavior.

## Cross-cutting patterns worth incorporating

### 1. Sidecar, not replacement

Most practical systems keep formal artifacts beside normal engineering artifacts. They do not replace all prose, docs, tests, or code with proofs.

kspec implication:

```text
kspec spec/plan/task/review remains the workflow source of truth
formal sidecar captures selected invariants
implementation tests/traces close the model-code gap
```

### 2. Separate abstract model from implementation linkage

Repeated pattern:

```text
abstract model/proof
  + implementation trace adapter or differential test
  + code-level harness where useful
```

kspec should explicitly distinguish:

- model check/proof passes;
- implementation conformance evidence exists;
- trace/differential/code harness evidence exists.

### 3. Make counterexamples first-class review artifacts

TLA+/Alloy/Apalache produce counterexamples. These should not be hidden in CI logs.

kspec could store or link:

- counterexample trace;
- minimized scenario;
- generated reproduction test;
- reviewer note explaining product impact.

### 4. Track assumptions and bounds

Bounded checks are only meaningful with visible bounds. Trace validation is only meaningful if logs are complete enough. Proofs with axioms or generated assumptions must expose those assumptions.

kspec formal metadata should eventually include:

```yaml
formal:
  assumptions:
    - traces include every task status transition
    - model bounds: at most 3 agents, 4 tasks, 2 reviews
  limits:
    - bounded counterexample search, not universal proof
    - UI display behavior not modeled
```

### 5. Prefer reusable templates

Projects with repeatable proof shapes scale better. Examples include per-component `spec / impl / correct` templates, trace-validation templates, and code-level proof harness templates.

kspec should provide templates for:

- lifecycle state machine sidecar;
- relational identity/alias sidecar;
- policy sidecar;
- implementation conformance test;
- final-report mapping;
- formal review checklist.

### 6. Expose one command per gate

Practical projects wrap formal tools in scripts or CI jobs. Agents should not need to remember whether a given sidecar uses `lake build`, `tlc2.TLC`, Alloy, Kani, CBMC, or Apalache.

kspec implication:

```yaml
formal:
  gate: scripts/check-formal-review-snapshot.sh
```

or eventually:

```bash
kspec formal check @review-snapshot-binding
```

### 7. Use formal methods where they beat tests

The best candidates are not ordinary CRUD behavior. They are places where tests under-sample the state space or reviewers lose track of global semantics:

- concurrency;
- state transitions;
- stale snapshot binding;
- canonical identity;
- authorization/security policy;
- graph/relationship invariants;
- preservation under refactor;
- fail-closed behavior;
- bounded input safety.

### 8. Avoid proof theater

Common failure modes:

- theorem restates a definition but proves no useful product property;
- model omits the bug-prone part of the system;
- implementation is never checked against the model;
- bounded check is described as a universal proof;
- proof relies on unchecked axioms or `sorry`;
- model is so implementation-specific that it becomes unreviewable and state-space explodes.

kspec reviews should explicitly reject these.

## Updated recommended sidecar architecture

The wider research suggests broadening the earlier sidecar model from only `formal artifact + proof` to a four-part contract:

```text
1. Intent layer
   kspec prose/spec/ACs identify the product invariant.

2. Model layer
   Lean/TLA+/Alloy/Cedar/etc. defines the formal semantics and checks/proofs.

3. Linkage layer
   property tests, differential tests, trace validation, generated tests, or code-level proof harnesses connect implementation behavior to the model.

4. Review/evidence layer
   CI output, counterexamples, assumptions, bounds, and model-code mappings are stored or referenced in kspec review artifacts.
```

This matters because the strongest public examples do not rely on a formal model alone. They combine formal models with implementation linkage and reviewable evidence.

## Cost and risk breakdown

### Sidecar-only spike

Estimated cost: low to medium.

Expected work:

- create a small formal project;
- model one invariant family;
- add a gate script;
- attach metadata to one spec or keep the metadata in a draft until schema support exists;
- write implementation conformance tests;
- define review expectations.

This is the recommended starting point.

### Broader formal sidecar program

Estimated cost: medium.

Expected work:

- formal artifact conventions;
- language/tool selection rules;
- dispatch prompt integration;
- validator support for referenced artifacts/checks;
- reviewer checklist and possible dedicated formal-review role;
- examples and templates for agents.

### Full spec migration to a formal language

Estimated cost: high.

Expected work:

- migrate the spec corpus;
- redesign authoring and review UX;
- rewrite plan/task derivation assumptions;
- train agents/reviewers;
- maintain proof obligations for ordinary changes;
- build bridges back to implementation and UI.

This is not recommended as the first move.

## Risks

### Formal model drift

The formal sidecar can drift away from implementation just like prose can. Mitigation:

- require implementation mapping in reviews;
- add conformance tests;
- include formal sidecars in task prompts;
- reject formal-only changes with no implementation alignment story.

### Vacuous proofs

A theorem can be true but useless. Mitigation:

- review for model adequacy;
- require counterexample/sanity tests where applicable;
- prefer theorem names tied to real product invariants;
- ban `sorry`/unchecked axioms in gated artifacts.

### Excessive proof burden

If every small product change requires proof work, the workflow will slow down. Mitigation:

- formalize only selected high-value invariants;
- make sidecars opt-in per spec;
- avoid verified implementation until there is clear evidence it pays off.

### Tooling friction

Lean/TLA+/Alloy/Dafny toolchains add setup cost. Mitigation:

- wrap tool invocations in project scripts;
- keep examples small;
- use CI/devcontainer setup once the first spike proves value;
- do not treat missing local binaries as a product argument against the approach.

### False confidence

A formal gate can become a badge that hides missing implementation coverage. Mitigation:

- review always includes both formal proof and implementation conformance;
- final reports must map code paths to formal concepts;
- tests must include stale/negative cases, not only accepted happy paths.

## Possible incremental adoption path

This is intentionally phrased as an adoption path, not concrete kspec tasks.

### Stage 1: One invariant spike

Use review snapshot binding as the initial example.

Outputs:

- one formal artifact;
- one gate script;
- one implementation conformance test;
- one reviewer checklist;
- one sample agent final-report mapping.

Success criteria:

- agents can understand the sidecar from prompt context;
- reviewers can evaluate whether the model matches the intended rule;
- the gate is deterministic;
- the conformance test clearly mirrors the theorem;
- the exercise reveals whether the added rigor is worth the overhead.

### Stage 2: Metadata and prompt integration

Add a lightweight way for specs to reference formal sidecars and for dispatch prompts to include sidecar requirements.

Potential checks:

- referenced artifact exists;
- required check names appear in the artifact;
- formalized specs add formal gate instructions to task prompts.

### Stage 3: Review integration

Formalized specs receive explicit review checks:

- formal gate passed;
- no proof escape hatches;
- implementation mapping present;
- conformance tests present;
- stale/negative cases covered.

### Stage 4: Expand only if useful

Add sidecars for one or two additional invariant families, likely dispatch canonical identity or task lifecycle. Do not expand to ordinary product specs unless the first examples demonstrate clear value.

## Open questions

- Which language should be the first default for kspec sidecars: Lean for theorem proofs, TLA+ for lifecycle checks, or Alloy for relational counterexamples?
- Should kspec own a formal-sidecar schema field, or should the initial integration live in prose conventions until the workflow proves useful?
- What is the minimal proof hygiene policy: ban `sorry`, ban all `axiom`, allow trusted imported libraries, require theorem naming conventions?
- How should implementation conformance be recorded in reviews?
- Should dispatch require formal gate evidence for formalized specs, or only surface instructions and let reviewers enforce it?
- Should formal artifacts be allowed to cover multiple specs, and if so how should ownership be represented?
- How should formal sidecars interact with generated plans/tasks and derived AC coverage?

## Recommended next decision

The next useful decision is whether to run a small spike around **review snapshot binding** using Lean as the first sidecar language.

The spike should be considered successful only if it produces the whole integration loop:

```text
formal model + proof
implementation predicate
conformance test
formal gate script
agent prompt instructions
review checklist
```

A Lean file alone would not be enough. The value is in the complete workflow that keeps product intent, formal semantics, implementation behavior, and review evidence aligned.
