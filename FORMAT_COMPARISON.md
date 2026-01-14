# Living Specification Format Comparison

A comprehensive analysis of data serialization formats for a "living spec" system that serves as the source of truth for project requirements, supports human and AI editing, hierarchical structure with graph-based cross-references, and plugin-based output generation.

## Table of Contents

1. [Requirements Summary](#requirements-summary)
2. [Format Comparison Matrix](#format-comparison-matrix)
3. [Detailed Format Analysis](#detailed-format-analysis)
4. [Concrete Examples](#concrete-examples)
5. [Recommendations](#recommendations)

---

## Requirements Summary

| Requirement | Priority | Notes |
|-------------|----------|-------|
| Human readability/editability | High | Humans must be able to author and review specs |
| AI agent parsability | High | LLMs and automation must reliably parse/generate |
| Hierarchical structure | High | Tree-like organization at top levels |
| Graph cross-references | High | Non-hierarchical links between items |
| Plain text / git-diffable | High | Version control friendly |
| Schema validation | Medium | Catch errors early, enforce structure |
| Plugin extensibility | Medium | Generate docs, tasks, reports |
| Ecosystem maturity | Medium | Existing tools and libraries |

---

## Format Comparison Matrix

| Criteria | YAML | JSON | XML | TOML | Turtle/RDF | JSON-LD | LinkML | Custom DSL |
|----------|------|------|-----|------|------------|---------|--------|------------|
| **Human Readability** | 8/10 | 6/10 | 5/10 | 9/10 | 7/10 | 6/10 | 8/10 | 9/10 |
| **Human Editability** | 7/10 | 5/10 | 4/10 | 8/10 | 6/10 | 5/10 | 8/10 | 8/10 |
| **AI Parsability** | 9/10 | 10/10 | 9/10 | 8/10 | 7/10 | 8/10 | 8/10 | 5/10 |
| **Hierarchy Support** | 9/10 | 9/10 | 10/10 | 6/10 | 7/10 | 9/10 | 9/10 | 10/10 |
| **Graph/Cross-refs** | 4/10 | 3/10 | 5/10 | 2/10 | 10/10 | 9/10 | 9/10 | 10/10 |
| **Git Diff Friendly** | 8/10 | 6/10 | 7/10 | 9/10 | 8/10 | 5/10 | 8/10 | 9/10 |
| **Schema Validation** | 6/10 | 8/10 | 10/10 | 5/10 | 8/10 | 8/10 | 9/10 | 7/10 |
| **Ecosystem/Tooling** | 9/10 | 10/10 | 10/10 | 7/10 | 6/10 | 7/10 | 5/10 | 1/10 |
| **Learning Curve** | Low | Low | Medium | Low | High | Medium | Medium | High |

---

## Detailed Format Analysis

### 1. YAML

**Overview**: YAML (YAML Ain't Markup Language) is a human-readable data serialization language widely used for configuration files.

**Pros**:
- Clean, minimal syntax with significant whitespace
- Excellent human readability for moderate complexity
- Native support for comments (unlike JSON)
- Multi-document support in single file
- Anchors (`&`) and aliases (`*`) for internal references
- Multiline strings with literal (`|`) and folded (`>`) styles
- Widely supported across programming languages
- Familiar to DevOps and developer communities

**Cons**:
- **Type coercion gotchas**: `NO` becomes boolean false (Norway problem), `1.0` becomes float
- **Boolean ambiguity**: `yes`, `no`, `on`, `off`, `y`, `n` all interpreted as booleans in YAML 1.1
- **Octal differences**: `0777` (YAML 1.1) vs `0o777` (YAML 1.2)
- **Indentation sensitivity**: Tabs vs spaces cause silent failures
- **Anchor limitations**: References are expanded on parse, lost on re-serialization
- **No native graph support**: Cross-references require convention-based ID schemes
- **Security risks**: Some parsers allow code execution (e.g., PyYAML's `!!python/object`)

**Schema Validation**:
- No native schema language
- Can use JSON Schema (many tools support it)
- External tools: Kwalify, Rx, YAML Schema

**Git Diff Friendliness**: Good for hierarchical data; line-based changes are clear. Complex anchors can make diffs harder to follow.

**Cross-Reference Pattern**:
```yaml
# Convention-based references using IDs
features:
  - id: auth-login
    title: User Login
    depends_on: [auth-session, user-model]  # Manual reference by ID

  - id: auth-session
    title: Session Management
    related_to: [auth-login]
```

---

### 2. JSON

**Overview**: JavaScript Object Notation, the lingua franca of web APIs.

**Pros**:
- Universal parsing support (every language, every platform)
- Unambiguous syntax with strict specification
- Excellent AI/LLM familiarity (training data prevalence)
- JSON Schema is mature and well-supported
- No type coercion surprises
- Streaming parsers available for large files

**Cons**:
- **No comments**: Significant limitation for documentation
- **Verbose**: Requires quotes around all keys, trailing comma forbidden
- **Poor multiline strings**: Must escape newlines as `\n`
- **No references**: Zero support for cross-references
- **Git diffs**: Bracket/brace changes can cascade through file

**Schema Validation**: JSON Schema is mature (2020-12 specification), widely supported, excellent tooling.

**Git Diff Friendliness**: Moderate. Arrays and objects can produce noisy diffs. Trailing comma prohibition means adding items changes previous lines.

**Cross-Reference Pattern**:
```json
{
  "features": [
    {
      "id": "auth-login",
      "title": "User Login",
      "depends_on": ["auth-session", "user-model"]
    }
  ]
}
```

---

### 3. XML

**Overview**: eXtensible Markup Language, enterprise standard with mature tooling.

**Pros**:
- **Schema validation**: XSD and DTD are extremely mature
- **Namespaces**: Avoid element name collisions
- **Mixed content**: Text and structured data can coexist
- **XPath/XQuery**: Powerful query languages built-in
- **Attributes vs elements**: Distinguish metadata from content
- **XSLT**: Transform to any output format
- **ID/IDREF**: Native cross-reference mechanism

**Cons**:
- **Extremely verbose**: Opening and closing tags for everything
- **Poor human editability**: Easy to misplace closing tags
- **Complex specification**: Namespaces, entities, DTDs add cognitive load
- **Heavy parsing**: Most resource-intensive format
- **Outdated perception**: Seen as "enterprise legacy"

**Schema Validation**: XSD (XML Schema Definition) is the gold standard for schema validation. DTDs are simpler but less expressive.

**Git Diff Friendliness**: Moderate to good. Line-per-element formatting helps. Namespace declarations can be noisy.

**Cross-Reference Pattern**:
```xml
<specification>
  <feature id="auth-login">
    <title>User Login</title>
    <depends-on>
      <ref idref="auth-session"/>
      <ref idref="user-model"/>
    </depends-on>
  </feature>
  <feature id="auth-session">
    <title>Session Management</title>
  </feature>
</specification>
```

---

### 4. TOML

**Overview**: Tom's Obvious, Minimal Language, designed for configuration files.

**Pros**:
- **Extremely readable**: Clean, obvious syntax
- **Explicit typing**: Clear distinction between strings, integers, dates
- **No indentation sensitivity**: Uses `[headers]` instead
- **Native date/time support**: First-class datetime values
- **Git diff friendly**: Flat structure produces clean diffs
- **Growing adoption**: Rust (Cargo.toml), Python (pyproject.toml)

**Cons**:
- **Limited nesting**: Designed for shallow structures, not deep hierarchies
- **No cross-references**: No mechanism for internal linking
- **Array of tables syntax**: `[[array]]` is confusing for newcomers
- **Inline table limitations**: Must be on single line
- **No stream markers**: Can't delimit multiple documents
- **Small ecosystem**: Fewer tools than YAML/JSON

**Schema Validation**: Limited. Taplo provides some validation. JSON Schema can be used with conversion.

**Git Diff Friendliness**: Excellent. Flat, line-oriented structure produces minimal diffs.

**Why Not for Living Specs**: TOML is explicitly not designed for deep nesting or complex data structures. The maintainers state: "Nesting complex structures is not a design goal."

---

### 5. RDF/Turtle/N3 (Semantic Web Formats)

**Overview**: Resource Description Framework and its serializations, designed for linked data and knowledge graphs.

**Turtle (Terse RDF Triple Language)**:
- Human-readable RDF serialization
- Subset of N3
- Subject-predicate-object triples

**N3 (Notation3)**:
- Superset of Turtle
- Adds rules and reasoning
- More expressive but complex

**Pros**:
- **Native graph model**: Designed for arbitrary relationships
- **Semantic precision**: URIs provide unambiguous identifiers
- **Query language**: SPARQL for complex queries
- **Inference**: OWL ontologies enable automated reasoning
- **Interoperability**: Link to external knowledge bases
- **W3C standard**: Formal specification, stable

**Cons**:
- **Steep learning curve**: Triple model is unfamiliar to most developers
- **Verbose URIs**: Full URIs make files noisy (prefixes help)
- **Tooling gap**: Fewer mainstream tools than JSON/YAML
- **Overkill**: Full semantic web stack may be excessive
- **Performance**: Costly to parse compared to simpler formats

**Schema Validation**: SHACL (Shapes Constraint Language) or ShEx (Shape Expressions).

**Git Diff Friendliness**: Good with Turtle. One statement per line. Prefix changes can cascade.

**Cross-Reference Pattern**:
```turtle
@prefix spec: <https://example.org/spec/> .
@prefix rel: <https://example.org/rel/> .

spec:auth-login a spec:Feature ;
    spec:title "User Login" ;
    rel:dependsOn spec:auth-session, spec:user-model .

spec:auth-session a spec:Feature ;
    spec:title "Session Management" ;
    rel:relatedTo spec:auth-login .
```

---

### 6. JSON-LD

**Overview**: JSON for Linked Data. Combines JSON's familiarity with RDF's semantic capabilities.

**Pros**:
- **Valid JSON**: Works with existing JSON tools
- **Graph semantics**: Can express arbitrary relationships
- **Context separation**: Schema definition separate from data
- **Upgrade path**: Add semantics to existing JSON
- **Flexible**: Can be processed as plain JSON or full RDF
- **Web-native**: Uses URLs for identifiers

**Cons**:
- **Complex parsing**: Full JSON-LD processing is expensive
- **Context overhead**: `@context` adds verbosity
- **Learning curve**: `@id`, `@type`, `@graph` require understanding
- **Fewer parsers**: Not all JSON-LD libraries are mature
- **Git diffs**: JSON limitations apply (no comments, trailing commas)
- **Two mental models**: Plain JSON vs linked data processing

**Schema Validation**: Can use JSON Schema for structure, SHACL for RDF constraints.

**Git Diff Friendliness**: Same as JSON (moderate). Context changes can be noisy.

**Cross-Reference Pattern**:
```json
{
  "@context": {
    "spec": "https://example.org/spec/",
    "dependsOn": {"@id": "spec:dependsOn", "@type": "@id"},
    "relatedTo": {"@id": "spec:relatedTo", "@type": "@id"}
  },
  "@graph": [
    {
      "@id": "spec:auth-login",
      "@type": "Feature",
      "title": "User Login",
      "dependsOn": ["spec:auth-session", "spec:user-model"]
    },
    {
      "@id": "spec:auth-session",
      "@type": "Feature",
      "title": "Session Management",
      "relatedTo": ["spec:auth-login"]
    }
  ]
}
```

---

### 7. LinkML (Linked Data Modeling Language)

**Overview**: A YAML-based modeling language that generates schemas for multiple formats (JSON Schema, RDF, SQL, etc.).

**Pros**:
- **YAML syntax**: Familiar, readable schema definitions
- **Multi-target**: Generates JSON Schema, ShEx, OWL, GraphQL, SQL DDL
- **Graph support**: Built-in slot references create graph relationships
- **Documentation generation**: Auto-generate human-readable docs
- **Validation**: Strong type system with constraints
- **Growing community**: Active development, especially in biomedical informatics

**Cons**:
- **Schema-focused**: More for defining structure than authoring data
- **Smaller ecosystem**: Fewer tools than mainstream formats
- **Learning curve**: LinkML-specific concepts
- **Python-centric**: Best tooling is Python-based

**Use Case**: Define your spec schema in LinkML, generate validators and documentation, author actual specs in YAML/JSON that conform to the schema.

**Schema Example**:
```yaml
id: https://example.org/spec
name: specification-schema
prefixes:
  linkml: https://w3id.org/linkml/
  spec: https://example.org/spec/

classes:
  Feature:
    attributes:
      id:
        identifier: true
      title:
        required: true
      depends_on:
        range: Feature
        multivalued: true
      related_to:
        range: Feature
        multivalued: true
```

---

### 8. Custom DSL

**Overview**: Design a domain-specific language tailored exactly to your needs.

**Pros**:
- **Perfect fit**: Syntax designed for your exact use case
- **Maximum readability**: Domain terms, not generic constructs
- **Built-in cross-references**: Native support for your relationship types
- **Extensibility**: Add features as needed

**Cons**:
- **Development cost**: Must build parser, validator, tooling
- **Maintenance burden**: Ongoing evolution and bug fixes
- **Learning curve**: Users must learn new syntax
- **AI compatibility**: LLMs may struggle without training data
- **Ecosystem of one**: No existing tools, libraries, or community

**When to Consider**:
- Your domain has very specific needs not met by existing formats
- You have resources to build and maintain tooling
- The DSL will be used extensively enough to justify investment
- You can provide sufficient examples for AI training

**Example** (Hypothetical Spec DSL):
```
@spec living-spec-system v1.0

feature auth-login "User Login" {
  description: """
    Allow users to authenticate with email/password
    or OAuth providers.
  """

  depends_on: auth-session, user-model

  acceptance_criteria {
    - "User can log in with valid credentials"
    - "Invalid credentials show error message"
    - "Session is created on successful login"
  }
}

feature auth-session "Session Management" {
  related_to: auth-login
  ...
}
```

---

### 9. Gherkin (Bonus: Behavior Specification)

**Overview**: The Given-When-Then language used by Cucumber for behavior-driven development.

**Pros**:
- Natural language syntax
- Executable specifications
- Living documentation
- Strong traceability

**Cons**:
- Focused on behavior/testing, not general specifications
- Limited structure beyond Feature/Scenario
- No built-in cross-references

**Relevance**: Could complement your spec format for acceptance criteria sections.

---

## Concrete Examples

The following examples show how the same specification snippet would look in each format:

### Specification Content:
- A "User Authentication" module
- Contains "Login" feature
- Login depends on "Session Management" and "User Model"
- Has acceptance criteria and priority metadata

---

### YAML Version

```yaml
# User Authentication Module Specification
# Version: 1.0.0
# Last Updated: 2025-01-14

modules:
  - id: user-auth
    title: User Authentication
    description: |
      Handles all aspects of user authentication including
      login, logout, session management, and password recovery.

    features:
      - id: auth-login
        title: User Login
        priority: high
        status: approved
        description: >
          Allow users to authenticate using email/password
          or configured OAuth providers.

        # Cross-references (convention-based)
        depends_on:
          - auth-session
          - user-model
        related_to:
          - auth-logout
          - password-recovery

        acceptance_criteria:
          - id: ac-1
            given: a registered user
            when: they enter valid credentials
            then: they are logged in and redirected to dashboard
          - id: ac-2
            given: a user
            when: they enter invalid credentials
            then: they see an error message

      - id: auth-session
        title: Session Management
        priority: high
        depends_on:
          - user-model
```

### JSON Version

```json
{
  "$schema": "./spec-schema.json",
  "version": "1.0.0",
  "modules": [
    {
      "id": "user-auth",
      "title": "User Authentication",
      "description": "Handles all aspects of user authentication including login, logout, session management, and password recovery.",
      "features": [
        {
          "id": "auth-login",
          "title": "User Login",
          "priority": "high",
          "status": "approved",
          "description": "Allow users to authenticate using email/password or configured OAuth providers.",
          "depends_on": ["auth-session", "user-model"],
          "related_to": ["auth-logout", "password-recovery"],
          "acceptance_criteria": [
            {
              "id": "ac-1",
              "given": "a registered user",
              "when": "they enter valid credentials",
              "then": "they are logged in and redirected to dashboard"
            },
            {
              "id": "ac-2",
              "given": "a user",
              "when": "they enter invalid credentials",
              "then": "they see an error message"
            }
          ]
        },
        {
          "id": "auth-session",
          "title": "Session Management",
          "priority": "high",
          "depends_on": ["user-model"]
        }
      ]
    }
  ]
}
```

### XML Version

```xml
<?xml version="1.0" encoding="UTF-8"?>
<specification
    xmlns="https://example.org/spec"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="https://example.org/spec spec-schema.xsd"
    version="1.0.0">

  <module id="user-auth">
    <title>User Authentication</title>
    <description>
      Handles all aspects of user authentication including
      login, logout, session management, and password recovery.
    </description>

    <feature id="auth-login">
      <title>User Login</title>
      <priority>high</priority>
      <status>approved</status>
      <description>
        Allow users to authenticate using email/password
        or configured OAuth providers.
      </description>

      <!-- Cross-references using IDREF -->
      <depends-on>
        <ref idref="auth-session"/>
        <ref idref="user-model"/>
      </depends-on>
      <related-to>
        <ref idref="auth-logout"/>
        <ref idref="password-recovery"/>
      </related-to>

      <acceptance-criteria>
        <criterion id="ac-1">
          <given>a registered user</given>
          <when>they enter valid credentials</when>
          <then>they are logged in and redirected to dashboard</then>
        </criterion>
        <criterion id="ac-2">
          <given>a user</given>
          <when>they enter invalid credentials</when>
          <then>they see an error message</then>
        </criterion>
      </acceptance-criteria>
    </feature>

    <feature id="auth-session">
      <title>Session Management</title>
      <priority>high</priority>
      <depends-on>
        <ref idref="user-model"/>
      </depends-on>
    </feature>
  </module>
</specification>
```

### Turtle (RDF) Version

```turtle
@prefix spec: <https://example.org/spec/> .
@prefix feat: <https://example.org/spec/feature/> .
@prefix mod: <https://example.org/spec/module/> .
@prefix crit: <https://example.org/spec/criteria/> .
@prefix rel: <https://example.org/spec/rel/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

# Module definition
mod:user-auth a spec:Module ;
    spec:title "User Authentication" ;
    spec:description """Handles all aspects of user authentication including
login, logout, session management, and password recovery.""" ;
    spec:hasFeature feat:auth-login, feat:auth-session .

# Login feature
feat:auth-login a spec:Feature ;
    spec:title "User Login" ;
    spec:priority "high" ;
    spec:status "approved" ;
    spec:description """Allow users to authenticate using email/password
or configured OAuth providers.""" ;
    rel:dependsOn feat:auth-session, feat:user-model ;
    rel:relatedTo feat:auth-logout, feat:password-recovery ;
    spec:hasCriterion crit:ac-1, crit:ac-2 .

# Acceptance criteria
crit:ac-1 a spec:AcceptanceCriterion ;
    spec:given "a registered user" ;
    spec:when "they enter valid credentials" ;
    spec:then "they are logged in and redirected to dashboard" .

crit:ac-2 a spec:AcceptanceCriterion ;
    spec:given "a user" ;
    spec:when "they enter invalid credentials" ;
    spec:then "they see an error message" .

# Session feature
feat:auth-session a spec:Feature ;
    spec:title "Session Management" ;
    spec:priority "high" ;
    rel:dependsOn feat:user-model .
```

### JSON-LD Version

```json
{
  "@context": {
    "spec": "https://example.org/spec/",
    "rel": "https://example.org/spec/rel/",
    "title": "spec:title",
    "description": "spec:description",
    "priority": "spec:priority",
    "status": "spec:status",
    "hasFeature": {"@id": "spec:hasFeature", "@type": "@id"},
    "dependsOn": {"@id": "rel:dependsOn", "@type": "@id"},
    "relatedTo": {"@id": "rel:relatedTo", "@type": "@id"},
    "hasCriterion": {"@id": "spec:hasCriterion", "@type": "@id"},
    "Module": "spec:Module",
    "Feature": "spec:Feature",
    "AcceptanceCriterion": "spec:AcceptanceCriterion"
  },
  "@graph": [
    {
      "@id": "spec:module/user-auth",
      "@type": "Module",
      "title": "User Authentication",
      "description": "Handles all aspects of user authentication including login, logout, session management, and password recovery.",
      "hasFeature": ["spec:feature/auth-login", "spec:feature/auth-session"]
    },
    {
      "@id": "spec:feature/auth-login",
      "@type": "Feature",
      "title": "User Login",
      "priority": "high",
      "status": "approved",
      "description": "Allow users to authenticate using email/password or configured OAuth providers.",
      "dependsOn": ["spec:feature/auth-session", "spec:feature/user-model"],
      "relatedTo": ["spec:feature/auth-logout", "spec:feature/password-recovery"],
      "hasCriterion": ["spec:criteria/ac-1", "spec:criteria/ac-2"]
    },
    {
      "@id": "spec:criteria/ac-1",
      "@type": "AcceptanceCriterion",
      "spec:given": "a registered user",
      "spec:when": "they enter valid credentials",
      "spec:then": "they are logged in and redirected to dashboard"
    },
    {
      "@id": "spec:feature/auth-session",
      "@type": "Feature",
      "title": "Session Management",
      "priority": "high",
      "dependsOn": ["spec:feature/user-model"]
    }
  ]
}
```

---

## Recommendations

### Primary Recommendation: YAML with Conventions + JSON Schema Validation

**Rationale**:

1. **Human Readability**: YAML strikes the best balance between readability and expressiveness
2. **AI Compatibility**: LLMs are extensively trained on YAML; parsing/generation is reliable
3. **Ecosystem**: Excellent tooling across all languages
4. **Git Friendliness**: Line-based format produces clean diffs
5. **Comments**: Native support crucial for documentation
6. **JSON Schema**: Provides validation without XML complexity

**Handling Cross-References**:
Establish conventions for ID-based references with a resolution layer:

```yaml
# spec.yaml
features:
  auth-login:
    title: User Login
    depends_on: ["@ref:auth-session", "@ref:user-model"]
```

**Mitigation for YAML Gotchas**:
1. Always use YAML 1.2 parsers
2. Quote all strings that might be misinterpreted
3. Use a linter (yamllint) in CI
4. Document conventions clearly

---

### Alternative: Hybrid Approach (YAML + JSON-LD Semantics)

If graph relationships are central to your use case:

1. Author specs in YAML for human editability
2. Define a JSON-LD context that maps YAML keys to semantic relationships
3. Process: YAML -> JSON -> JSON-LD for graph operations
4. Use SHACL/ShEx for validation of graph constraints

This gives you:
- Human-friendly authoring (YAML)
- Full graph semantics when needed (JSON-LD/RDF)
- Standard validation (JSON Schema + SHACL)

---

### Not Recommended

| Format | Reason |
|--------|--------|
| **TOML** | Insufficient nesting depth; no cross-reference support |
| **Pure RDF/Turtle** | Learning curve too steep; overkill for most teams |
| **Custom DSL** | Maintenance burden outweighs benefits unless very specific needs |
| **XML** | Verbosity hurts human editability; perception issues |
| **Pure JSON** | Lack of comments is a dealbreaker for specifications |

---

### Implementation Strategy

1. **Phase 1**: Define spec structure in LinkML or JSON Schema
2. **Phase 2**: Author specs in YAML following strict conventions
3. **Phase 3**: Build validation pipeline (schema + custom cross-ref validation)
4. **Phase 4**: Create plugin system for output generation (Markdown docs, task lists, etc.)
5. **Phase 5**: If graph queries become critical, add JSON-LD processing layer

---

## Sources

### YAML
- [YAML 1.2.2 Specification](https://yaml.org/spec/1.2.2/)
- [7 YAML Gotchas to Avoid - InfoWorld](https://www.infoworld.com/article/2336307/7-yaml-gotchas-to-avoidand-how-to-avoid-them.html)
- [YAML Multiline Strings](https://yaml-multiline.info/)

### JSON/JSON Schema
- [JSON Schema Specification](https://json-schema.org/specification)
- [JSON Schema Getting Started](https://json-schema.org/learn/getting-started-step-by-step)

### XML
- [XML vs YAML Comparison - TechTarget](https://www.techtarget.com/searchdatacenter/tip/XML-vs-YAML-Compare-configuration-file-formats)

### RDF/Turtle
- [RDF 1.1 Turtle - W3C](https://www.w3.org/TR/turtle/)
- [RDF Serialization Formats Comparison - Ontola](https://ontola.io/blog/rdf-serialization-formats)
- [Notation3 Language - W3C](https://w3c.github.io/N3/spec/)

### JSON-LD
- [JSON-LD 1.1 - W3C](https://www.w3.org/TR/json-ld11/)
- [JSON-LD Primer](https://json-ld.org/primer/latest/)

### LinkML
- [LinkML Documentation](https://linkml.io/linkml/)
- [LinkML Overview](https://linkml.io/linkml/intro/overview.html)

### TOML
- [TOML Specification](https://toml.io/en/)
- [TOML GitHub](https://github.com/toml-lang/toml)

### Custom DSL
- [Domain Specific Languages - Martin Fowler](https://martinfowler.com/dsl.html)
- [DSL Guide - Wikipedia](https://en.wikipedia.org/wiki/Domain-specific_language)

### Gherkin
- [Gherkin Reference - Cucumber](https://cucumber.io/docs/gherkin/reference/)

### Git Diff
- [Git Diff Documentation](https://git-scm.com/docs/git-diff)
- [Understanding Diff Formats](https://dev.to/shrsv/understanding-diff-formats-a-developers-guide-to-making-sense-of-changes-414o)
