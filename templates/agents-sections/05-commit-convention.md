## Commit Convention

```
feat: Feature description

Task: @task-slug
Spec: @spec-ref
```

Trailers enable `kspec log @ref` to find commits by task or spec.

## Code Annotations

Link tests to acceptance criteria using language-appropriate comment syntax:

```javascript
// AC: @spec-item ac-N
it('should validate input', () => { ... });
```

```python
# AC: @spec-item ac-N
def test_validates_input():
    ...
```

Every AC SHOULD have at least one test with this annotation.

### N/A Trait ACs

When a trait AC doesn't apply to a specific spec, annotate it as N/A with a reason:

```javascript
// AC: @trait-slug ac-N — N/A: reason why it doesn't apply
```

```python
# AC: @trait-slug ac-N — N/A: reason why it doesn't apply
```

Group N/A annotations together in a dedicated test or at the top of the test file. The `AC:` annotation marker with language-appropriate comment prefix is required — do not use prose comments or bullet lists. The annotation must be machine-parseable.
