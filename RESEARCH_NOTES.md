# Kynetic Spec: Research Notes

This document captures detailed research findings that informed the design decisions in `KYNETIC_SPEC_DESIGN.md`.

---

## Table of Contents

1. [Format Comparison Insights](#format-comparison-insights)
2. [Traceability Research](#traceability-research)
3. [Versioning Best Practices](#versioning-best-practices)
4. [CLI Design Patterns](#cli-design-patterns)
5. [Competitor Analysis](#competitor-analysis)
6. [Sources and References](#sources-and-references)

---

## Format Comparison Insights

### Why YAML Won

| Criteria | YAML | JSON | XML | RDF/Turtle | JSON-LD |
|----------|------|------|-----|------------|---------|
| Human Readability | 8/10 | 6/10 | 5/10 | 7/10 | 6/10 |
| AI Parsability | 9/10 | 10/10 | 9/10 | 7/10 | 8/10 |
| Graph Support | 4/10 | 3/10 | 5/10 | 10/10 | 9/10 |
| Git Diffs | 8/10 | 6/10 | 7/10 | 8/10 | 5/10 |
| Comments | Yes | No | Yes | Yes | No |
| Ecosystem | Mature | Mature | Mature | Niche | Growing |

**Decision**: YAML provides the best balance of human and machine usability. Comments are essential for specifications, ruling out JSON. XML is too verbose. RDF has too steep a learning curve for mainstream adoption.

### YAML Gotchas to Mitigate

1. **Boolean coercion**: `NO` (Norway country code) becomes `false`
   - **Mitigation**: Always quote ambiguous strings, use YAML 1.2 parsers

2. **Version differences**: YAML 1.1 vs 1.2 interpret values differently
   - **Mitigation**: Standardize on YAML 1.2, document parser requirements

3. **Indentation sensitivity**: Tabs cause silent failures
   - **Mitigation**: Enforce with yamllint in CI

4. **Anchors lost on roundtrip**: YAML anchors expand when re-serialized
   - **Mitigation**: Use convention-based ID references instead of anchors

### LinkML as a Meta-Layer

[LinkML](https://linkml.io/) is worth investigating as a **schema definition layer**:
- Define spec schema in LinkML (YAML-based)
- Auto-generates JSON Schema, RDF/SHACL, SQL DDL, documentation
- Built-in support for cross-references between types
- Author actual specs in YAML conforming to generated schema

This could provide a path to RDF/semantic capabilities without requiring users to learn RDF directly.

---

## Traceability Research

### Industry Standards for Traceability

**DO-178C (Aviation)**:
- Requires bidirectional traceability from system requirements through code to tests
- Every line of safety-critical code must trace to a requirement
- Structural coverage analysis required

**IEC 62304 (Medical Devices)**:
- Software safety classification (A, B, C) determines traceability rigor
- Class C (risk of death) requires complete traceability
- Class A may have minimal requirements

**ISO 26262 (Automotive)**:
- ASIL levels (A-D) determine rigor
- Full requirements traceability to test cases
- Compliance matrices map regulations to requirements

**Common Pattern**: All regulated industries require traceability, but the required rigor scales with risk level.

### Traceability Maintenance is the Biggest Challenge

Research consistently identifies manual traceability maintenance as the primary blocker:

> "Establishing and maintaining traceability links manually places an extra burden on developers and is error-prone"

> "The manual work necessary to construct, maintain and analyze trace links creates so much overhead to the change process"

**Key Insight**: This is why the tiered approach matters. Start with implicit/convention-based traceability (low overhead), only add formal traceability when compliance requires it.

### Emerging AI-Powered Traceability

Recent research shows 32% improvement in automated traceability accuracy with structured prompts. AI tools can:
- Infer connections based on naming conventions and semantics
- Suggest links without explicit annotations
- Validate existing links for staleness

This suggests future tooling could provide "Tier 2.5" - convention-based with AI assistance.

---

## Versioning Best Practices

### Git-Native vs Custom Versioning

**Recommendation**: Leverage git for what it does well, add semantic meaning where git falls short.

| Concern | Use Git | Add Custom |
|---------|---------|------------|
| Who changed what | Commits | - |
| When it changed | Commits | - |
| Named releases | Tags | Semantic version in manifest |
| What changed semantically | Diff | Changelog generation |
| Item identity | - | Stable UIDs |

### UID Best Practices

From DoD IUID standard:
> "A unique item identifier is only assigned to a single item and is never reused. Once assigned, the IUID is never changed even if the item is modified"

**Pattern**: `{prefix}-{category}-{number}` e.g., `REQ-AUTH-001`

**Rules**:
1. Never reuse IDs (even after deletion)
2. Never rename IDs
3. IDs are stable references; titles can change

### Lifecycle Models

**RFC Standards Track**:
```
Proposed Standard -> Draft Standard -> Internet Standard
                  -> Historic (obsolete)
                  -> Experimental (unproven)
```

**R Package Lifecycle**:
```
Experimental -> Stable -> Deprecated/Superseded -> Defunct
            (soft deprecation as intermediate warning)
```

**Recommendation**: Simple model for Kynetic Spec:
```
draft -> proposed -> stable -> deprecated -> archived
```

---

## CLI Design Patterns

### Git Plumbing vs Porcelain

Git's distinction between low-level "plumbing" commands (for scripts) and high-level "porcelain" commands (for humans) is valuable:

**Plumbing** (atomic, composable):
```bash
kspec item get auth-login --field status
kspec item set auth-login --field status --value done
```

**Porcelain** (convenient, workflow-oriented):
```bash
kspec complete auth-login  # Sets status + timestamps
kspec promote auth-login   # Multi-step workflow
```

### Agent-Friendly Design Principles

From analysis of kubectl, gh, terraform, jq:

1. **JSON output mode**: All commands support `--json` or `--output json`
2. **Idempotent operations**: `--if-not-exists`, `--if-changed` flags
3. **Non-interactive mode**: `--no-prompt` flag for automation
4. **Dry-run capability**: Show what would change without applying
5. **Structured errors**: JSON errors with codes, not just text
6. **Semantic exit codes**: 0=success, 3=not found, 4=validation failed

### Query Patterns

**Structured flags** (discoverable, simple cases):
```bash
kspec item list --status pending --type requirement
```

**Expression language** (powerful, complex cases):
```bash
kspec query '.items[] | select(.priority == "high")'
```

**Recommendation**: Support both. Flags for common cases, jq-style expressions for complex queries.

---

## Competitor Analysis

### Requirements Management Tools

| Tool | Format | Strengths | Weaknesses |
|------|--------|-----------|------------|
| **IBM DOORS** | Proprietary | Industry standard, full traceability | Expensive, heavyweight |
| **Jama Connect** | Proprietary | Medical device focus | Vendor lock-in |
| **ReqIF** | XML | Interchange standard | Complex, not for authoring |
| **Doorstop** | YAML | Git-native, open source | Limited features |
| **ReqView** | JSON | Git-native, lightweight | Single-vendor |

**Key Insight**: Most tools are either heavyweight enterprise (DOORS) or lightweight but limited (Doorstop). Gap exists for "git-native, agent-friendly, progressively complex" solution.

### Documentation-as-Code

| Tool | Purpose | Format |
|------|---------|--------|
| **OpenAPI** | API specs | YAML/JSON |
| **AsyncAPI** | Event-driven APIs | YAML |
| **Gherkin** | BDD specs | Custom DSL |
| **ADRs** | Architecture decisions | Markdown |
| **Structurizr** | Architecture diagrams | Custom DSL |

**Pattern**: Domain-specific formats that are plain text and git-friendly are successful.

### AI-Agent Context Systems

Emerging tools for AI agent project context:
- Claude Projects (context files)
- Cursor Rules (.cursorrules)
- Aider conventions

**Gap**: None of these are structured specification systems. They're context hints, not sources of truth.

---

## Sources and References

### Format Research
- [YAML 1.2.2 Specification](https://yaml.org/spec/1.2.2/)
- [7 YAML Gotchas - InfoWorld](https://www.infoworld.com/article/2336307/7-yaml-gotchas-to-avoidand-how-to-avoid-them.html)
- [JSON Schema 2020-12](https://json-schema.org/specification)
- [RDF 1.1 Turtle - W3C](https://www.w3.org/TR/turtle/)
- [JSON-LD 1.1 - W3C](https://www.w3.org/TR/json-ld11/)
- [LinkML Documentation](https://linkml.io/linkml/)

### Traceability Research
- [Perforce - Requirements Traceability Matrix](https://www.perforce.com/resources/alm/requirements-traceability-matrix)
- [LDRA - DO-178C Certification](https://ldra.com/do-178/)
- [Parasoft - IEC 62304 Compliance](https://www.parasoft.com/solutions/iec-62304/)
- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)

### Versioning Research
- [Semantic Versioning 2.0.0](https://semver.org/)
- [RFC 2026 - Internet Standards Process](https://www.rfc-editor.org/rfc/rfc2026.html)
- [R lifecycle Package](https://lifecycle.r-lib.org/articles/stages.html)
- [ADR GitHub Organization](https://adr.github.io/)

### CLI Design Research
- [Git Internals - Plumbing and Porcelain](https://git-scm.com/book/en/v2/Git-Internals-Plumbing-and-Porcelain)
- [kubectl Reference](https://kubernetes.io/docs/reference/kubectl/)
- [GitHub CLI Manual](https://cli.github.com/manual/)
- [jq Manual](https://jqlang.org/manual/)
- [AI Agent CLI Patterns - InfoQ](https://www.infoq.com/articles/ai-agent-cli/)

### Competitor Research
- [IBM DOORS Documentation](https://www.ibm.com/docs/en/engineering-lifecycle-management-suite/doors)
- [Doorstop GitHub](https://github.com/doorstop-dev/doorstop)
- [ReqIF Wikipedia](https://en.wikipedia.org/wiki/Requirements_Interchange_Format)
- [OpenAPI Specification](https://spec.openapis.org/oas/latest.html)
- [Cucumber Gherkin Reference](https://cucumber.io/docs/gherkin/reference/)
